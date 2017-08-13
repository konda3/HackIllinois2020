var ERR = require('async-stacktrace');
var _ = require('lodash');
var async = require('async');
var path = require('path');
var debug = require('debug')('prairielearn:' + path.basename(__filename, '.js'));

var messageQueue = require('./messageQueue');
var sqldb = require('./sqldb');
var sqlLoader = require('./sql-loader');
var questionServers = require('../question-servers');

var sql = sqlLoader.loadSqlEquiv(__filename);

/**
 * Question module.
 * @module question
 */

/**
 * Internal error type for tracking lack of submission.
 */
class NoSubmissionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoSubmissionError';
  }
}

module.exports = {
    /**
     * Internal function, do not call directly. Write the courseErrs for a variant to the DB.
     * @protected
     *
     * @param {Object} client - SQL client that must be inside a transaction.
     * @param {Array} courseErrs - List of Error() objects for to be written.
     * @param {number} variant_id - The variant associated with the errors.
     * @param {number} authn_user_id - The currently authenticated user.
     * @param {string} studentMessage - The error message to display to the student.
     * @param {Object} courseData - Arbitrary data to be associated with the errors.
     * @param {function} callback - A callback(err) function.
     */
    _writeCourseErrs(client, courseErrs, variant_id, authn_user_id, studentMessage, courseData, callback) {
        async.eachSeries(courseErrs, (courseErr, callback) => {
            const params = [
                variant_id,
                studentMessage,
                courseErr.toString(), // instructor message
                true, // course_caused
                courseData,
                {stack: courseErr.stack, courseErrData: courseErr.data}, // system_data
                authn_user_id,
            ];
            if (client) {
                sqldb.callWithClient(client, 'errors_insert_for_variant', params, (err) => {
                    if (ERR(err, callback)) return;
                    return callback(null);
                });
            } else {
                sqldb.call('errors_insert_for_variant', params, (err) => {
                    if (ERR(err, callback)) return;
                    return callback(null);
                });
            }
        }, (err) => {
            if (ERR(err, callback)) return;
            callback(null);
        });
    },

    /**
     * Internal function, do not call directly. Create a variant object, do not write to DB.
     * @protected
     *
     * @param {Object} question - The question for the variant.
     * @param {Object} course - The course for the variant.
     * @param {Object} options - Options controlling the creation: options = {variant_seed}
     * @param {function} callback - A callback(err, courseErrs, variant) function.
     */
    _makeVariant(question, course, options, callback) {
        var variant_seed;
        if (_(options).has('variant_seed')) {
            variant_seed = options.variant_seed;
        } else {
            variant_seed = Math.floor(Math.random() * Math.pow(2, 32)).toString(36);
        }
        questionServers.getModule(question.type, (err, questionModule) => {
            if (ERR(err, callback)) return;
            questionModule.generate(question, course, variant_seed, (err, courseErrs, data) => {
                if (ERR(err, callback)) return;
                const hasFatalError = _.some(_.map(courseErrs, 'fatal'));
                var variant = {
                    variant_seed: variant_seed,
                    params: data.params || {},
                    true_answer: data.true_answer || {},
                    options: data.options || {},
                    broken: hasFatalError,
                };
                if (variant.broken) {
                    return callback(null, courseErrs, variant);
                }
                questionModule.prepare(question, course, variant, (err, extraCourseErrs, data) => {
                    if (ERR(err, callback)) return;
                    courseErrs.push(...extraCourseErrs);
                    const hasFatalError = _.some(_.map(courseErrs, 'fatal'));
                    var variant = {
                        variant_seed: variant_seed,
                        params: data.params || {},
                        true_answer: data.true_answer || {},
                        options: data.options || {},
                        broken: hasFatalError,
                    };
                    callback(null, courseErrs, variant);
                });
            });
        });
    },

    /**
     * Internal function, do not call directly. Get a question by either question_id or instance_question_id.
     * @protected
     *
     * @param {?number} question_id - The question for the new variant. Can be null if instance_question_id is provided.
     * @param {?number} instance_question_id - The instance question for the new variant. Can be null if question_id is provided.
     * @param {function} callback - A callback(err, question) function.
     */
    _selectQuestionWithClient(client, question_id, instance_question_id, callback) {
        if (question_id != null) {
            sqldb.callWithClientOneRow(client, 'questions_select', [question_id], (err, result) => {
                if (ERR(err, callback)) return;
                const question = result.rows[0];
                callback(null, question);
            });
        } else {
            if (instance_question_id == null) return callback(new Error('question_id and instance_question_id cannot both be null'));
            sqldb.callWithClientOneRow(client, 'instance_questions_select_question', [instance_question_id], (err, result) => {
                if (ERR(err, callback)) return;
                const question = result.rows[0];
                callback(null, question);
            });
        }
    },

    /**
     * Internal function, do not call directly. Create a variant object, and write it to the DB.
     * @protected
     *
     * @param {Object} client - SQL client that must be inside a transaction.
     * @param {?number} question_id - The question for the new variant. Can be null if instance_question_id is provided.
     * @param {?number} instance_question_id - The instance question for the new variant, or null for a floating variant.
     * @param {number} user_id - The user for the new variant.
     * @param {number} authn_user_id - The current authenticated user.
     * @param {Object} course - The course for the variant.
     * @param {Object} options - Options controlling the creation: options = {variant_seed}
     * @param {function} callback - A callback(err, variant) function.
     */
    _makeAndInsertVariantWithClient(client, question_id, instance_question_id, user_id, authn_user_id, course, options, callback) {
        this._selectQuestionWithClient(client, question_id, instance_question_id, (err, question) => {
            if (ERR(err, callback)) return;
            this._makeVariant(question, course, options, (err, courseErrs, variant) => {
                if (ERR(err, callback)) return;

                const params = [
                    variant.variant_seed,
                    variant.params,
                    variant.true_answer,
                    variant.options,
                    variant.broken,
                    instance_question_id,
                    question.id,
                    user_id,
                    authn_user_id,
                ];
                sqldb.callWithClientOneRow(client, 'variants_insert', params, (err, result) => {
                    if (ERR(err, callback)) return;
                    const variant = result.rows[0];

                    const studentMessage = 'Error creating question variant';
                    const courseData = {variant, question, course};
                    this._writeCourseErrs(client, courseErrs, variant.id, authn_user_id, studentMessage, courseData, (err) => {
                        if (ERR(err, callback)) return;
                        return callback(null, variant);
                    });
                });
            });
        });
    },

    /**
     * Internal function, do not call directly. Make sure there is a variant for an instance question.
     * @protected
     *
     * @param {Object} client - SQL client that must be inside a transaction.
     * @param {?number} question_id - The question for the new variant. Can be null if instance_question_id is provided.
     * @param {?number} instance_question_id - The instance question for the new variant, or null for a floating variant.
     * @param {number} user_id - The user for the new variant.
     * @param {number} authn_user_id - The current authenticated user.
     * @param {Object} course - The course for the variant.
     * @param {Object} options - Options controlling the creation: options = {variant_seed}
     * @param {boolean} require_open - If true, only use an existing variant if it is open.
     * @param {function} callback - A callback(err, variant) function.
     */
    _ensureVariantWithClient(client, question_id, instance_question_id, user_id, authn_user_id, course, options, require_open, callback) {
        if (instance_question_id != null) {
            // see if we have a useable existing variant, otherwise
            // make a new one
            var params = [
                instance_question_id,
                require_open,
            ];
            sqldb.callWithClient(client, 'instance_questions_select_variant', params, (err, result) => {
                if (ERR(err, callback)) return;
                if (result.rowCount == 1) {
                    const variant = result.rows[0];
                    return callback(null, variant);
                }
                this._makeAndInsertVariantWithClient(client, question_id, instance_question_id, user_id, authn_user_id, course, options, (err, variant) => {
                    if (ERR(err, callback)) return;
                    callback(null, variant);
                });
            });
        } else {
            // if we don't have instance_question_id, just make a new variant
            this._makeAndInsertVariantWithClient(client, question_id, instance_question_id, user_id, authn_user_id, course, options, (err, variant) => {
                if (ERR(err, callback)) return;
                callback(null, variant);
            });
        }
    },

    /**
     * Ensure that there is a variant for the given instance question.
     *
     * @param {?number} question_id - The question for the new variant. Can be null if instance_question_id is provided.
     * @param {?number} instance_question_id - The instance question for the new variant, or null for a floating variant.
     * @param {number} user_id - The user for the new variant.
     * @param {number} authn_user_id - The current authenticated user.
     * @param {Object} course - The course for the variant.
     * @param {Object} options - Options controlling the creation: options = {variant_seed}
     * @param {boolean} require_open - If true, only use an existing variant if it is open.
     * @param {function} callback - A callback(err, variant) function.
     */
    ensureVariant(question_id, instance_question_id, user_id, authn_user_id, course, options, require_open, callback) {
        let variant;
        sqldb.beginTransaction((err, client, done) => {
            if (ERR(err, callback)) return;
            async.series([
                // Even though we only have a single series function,
                // we use the async.series pattern for consistency and
                // to make sure we correctly call endTransaction even
                // in the presence of errors.
                (callback) => {
                    this._ensureVariantWithClient(client, question_id, instance_question_id, user_id, authn_user_id, course, options, require_open, (err, ret_variant) => {
                        if (ERR(err, callback)) return;
                        variant = ret_variant;
                        callback(null);
                    });
                },
            ], (err) => {
                sqldb.endTransaction(client, done, err, (err) => {
                    if (ERR(err, callback)) return;
                    callback(null, variant);
                });
            });
        });
    },

    /**
     * Internal worker for saveSubmission(). Do not call directly.
     * @protected
     * 
     * @param {Object} client - SQL client that must be inside a transaction.
     * @param {Object} submission - The submission to save (should not have an id property yet).
     * @param {Object} variant - The variant to submit to.
     * @param {Object} question - The question for the variant.
     * @param {Object} course - The course for the variant.
     * @param {function} callback - A callback(err, submission_id) function.
     */
    _saveSubmissionWithClient(client, submission, variant, question, course, callback) {
        debug('_saveSubmissionWithClient()');
        submission.raw_submitted_answer = submission.submitted_answer;
        submission.gradable = true;
        let questionModule, courseErrs, data, submission_id;
        async.series([
            (callback) => {
                questionServers.getModule(question.type, (err, ret_questionModule) => {
                    if (ERR(err, callback)) return;
                    questionModule = ret_questionModule;
                    debug('_saveSubmissionWithClient()', 'loaded questionModule');
                    callback(null);
                });
            },
            (callback) => {
                questionModule.parse(submission, variant, question, course, (err, ret_courseErrs, ret_data) => {
                    if (ERR(err, callback)) return;
                    courseErrs = ret_courseErrs;
                    data = ret_data;
                    debug('_saveSubmissionWithClient()', 'completed parse()');
                    callback(null);
                });
            },
            (callback) => {
                const studentMessage = 'Error parsing submission';
                const courseData = {variant, question, submission, course};
                this._writeCourseErrs(client, courseErrs, variant.id, submission.auth_user_id, studentMessage, courseData, (err) => {
                    if (ERR(err, callback)) return;
                    debug('_saveSubmissionWithClient()', 'wrote courseErrs');
                    callback(null);
                });
            },
            (callback) => {
                const hasFatalError = _.some(_.map(courseErrs, 'fatal'));
                if (hasFatalError) data.gradable = false;

                const params = [
                    data.submitted_answer,
                    data.raw_submitted_answer,
                    data.format_errors,
                    data.gradable,
                    submission.credit,
                    submission.mode,
                    submission.variant_id,
                    submission.auth_user_id,
                ];
                sqldb.callWithClientOneRow(client, 'submissions_insert', params, (err, result) => {
                    if (ERR(err, callback)) return;
                    submission_id = result.rows[0].submission_id;
                    debug('_saveSubmissionWithClient()', 'inserted', 'submission_id:', submission_id);
                    callback(null);
                });
            },
        ], (err) => {
            if (ERR(err, callback)) return;
            debug('_saveSubmissionWithClient()', 'returning', 'submission_id:', submission_id);
            callback(null, submission_id);
        });
    },

    /**
     * Save a new submission to a variant into the database.
     * 
     * @param {Object} submission - The submission to save (should not have an id property yet).
     * @param {Object} variant - The variant to submit to.
     * @param {Object} question - The question for the variant.
     * @param {Object} course - The course for the variant.
     * @param {function} callback - A callback(err, submission_id) function.
     */
    saveSubmission(submission, variant, question, course, callback) {
        let submission_id;
        sqldb.beginTransaction((err, client, done) => {
            if (ERR(err, callback)) return;
            async.series([
                // Even though we only have a single series function,
                // we use the async.series pattern for consistency and
                // to make sure we correctly call endTransaction even
                // in the presence of errors.
                (callback) => {
                    this._saveSubmissionWithClient(client, submission, variant, question, course, (err, ret_submission_id) => {
                        if (ERR(err, callback)) return;
                        submission_id = ret_submission_id;
                        callback(null);
                    });
                },
            ], (err) => {
                sqldb.endTransaction(client, done, err, (err) => {
                    if (ERR(err, callback)) return;
                    callback(null, submission_id);
                });
            });
        });
    },

    /**
     * Internal worker for gradeVariant(). Do not call directly.
     * @protected
     *
     * @param {Object} client - SQL client that must be inside a transaction.
     * @param {Object} variant - The variant to grade.
     * @param {?number} check_submission_id - The submission_id that must be graded (or null to skip this check).
     * @param {Object} question - The question for the variant.
     * @param {Object} course - The course for the variant.
     * @param {number} authn_user_id - The currently authenticated user.
     * @param {function} callback - A callback(err) function.
     */
    _gradeVariantWithClient(client, variant, check_submission_id, question, course, authn_user_id, callback) {
        debug('_gradeVariantWithClient()');
        let questionModule, courseErrs, data, submission, grading_job;
        async.series([
            (callback) => {
                var params = [
                    variant.id,
                    check_submission_id,
                ];
                sqldb.callWithClientZeroOrOneRow(client, 'variants_select_submission_for_grading', params, (err, result) => {
                    if (ERR(err, callback)) return;
                    if (result.rowCount == 0) return callback(new NoSubmissionError());
                    submission = result.rows[0];
                    debug('_gradeVariantWithClient()', 'selected submission', 'submission.id:', submission.id);
                    callback(null);
                });
            },
            (callback) => {
                questionServers.getModule(question.type, (err, ret_questionModule) => {
                    if (ERR(err, callback)) return;
                    questionModule = ret_questionModule;
                    debug('_gradeVariantWithClient()', 'loaded questionModule');
                    callback(null);
                });
            },
            (callback) => {
                if (question.grading_method == 'Internal') {
                    // for Internal grading we call the grading code
                    questionModule.grade(submission, variant, question, course, (err, ret_courseErrs, ret_data) => {
                        if (ERR(err, callback)) return;
                        courseErrs = ret_courseErrs;
                        data = ret_data;
                        const hasFatalError = _.some(_.map(courseErrs, 'fatal'));
                        if (hasFatalError) data.gradable = false;
                        debug('_gradeVariantWithClient()', 'completed grade()', 'hasFatalError:', hasFatalError);
                        callback(null);
                    });
                } else {
                    // for External or Manual grading we don't do anything
                    courseErrs = [];
                    data = {};
                    callback(null);
                }
            },
            (callback) => {
                const studentMessage = 'Error grading submission';
                const courseData = {variant, question, submission, course};
                this._writeCourseErrs(client, courseErrs, variant.id, submission.auth_user_id, studentMessage, courseData, (err) => {
                    if (ERR(err, callback)) return;
                    debug('_gradeVariantWithClient()', 'wrote courseErrs');
                    callback(null);
                });
            },
            (callback) => {
                const params = [
                    submission.id,
                    authn_user_id,
                    data.gradable,
                    data.format_errors,
                    data.partial_scores,
                    data.score,
                    data.feedback,
                    data.submitted_answer,
                    data.params,
                    data.true_answer,
                ];
                sqldb.callWithClientOneRow(client, 'grading_jobs_insert', params, (err, result) => {
                    if (ERR(err, callback)) return;
                    grading_job = result.rows[0];
                    debug('_gradeVariantWithClient()', 'inserted', 'grading_job.id:', grading_job.id);
                    callback(null);
                });
            },
            (callback) => {
                if (grading_job.grading_method == 'External') {
                    messageQueue.sendToGradingQueue(grading_job.id, submission, variant, question, course);
                    debug('_gradeVariantWithClient()', 'sent job to grading queue');
                }
                callback(null);
            },
        ], (err) => {
            // catch NoSubmissionError as we are just using it to exit with no action
            if (err instanceof NoSubmissionError) {
                debug('_gradeVariantWithClient()', 'no submissions for grading, skipping');
                err = null;
            }
            if (ERR(err, callback)) return;
            debug('_gradeVariantWithClient()', 'success');
            callback(null);
        });
        
    },

    /**
     * Grade the most recent submission for a given variant.
     * 
     * @param {Object} variant - The variant to grade.
     * @param {?number} check_submission_id - The submission_id that must be graded (or null to skip this check).
     * @param {Object} question - The question for the variant.
     * @param {Object} course - The course for the variant.
     * @param {number} authn_user_id - The currently authenticated user.
     * @param {function} callback - A callback(err) function.
     */
    gradeVariant(variant, check_submission_id, question, course, authn_user_id, callback) {
        sqldb.beginTransaction((err, client, done) => {
            if (ERR(err, callback)) return;
            async.series([
                // Even though we only have a single series function,
                // we use the async.series pattern for consistency and
                // to make sure we correctly call endTransaction even
                // in the presence of errors.
                (callback) => {
                    this._gradeVariantWithClient(client, variant, check_submission_id, question, course, authn_user_id, (err) => {
                        if (ERR(err, callback)) return;
                        callback(null);
                    });
                },
            ], (err) => {
                sqldb.endTransaction(client, done, err, (err) => {
                    if (ERR(err, callback)) return;
                    callback(null);
                });
            });
        });
    },

    /**
     * Save and grade a new submission to a variant.
     * 
     * @param {Object} submission - The submission to save (should not have an id property yet).
     * @param {Object} variant - The variant to submit to.
     * @param {Object} question - The question for the variant.
     * @param {Object} course - The course for the variant.
     * @param {function} callback - A callback(err, submission_id) function.
     */
    saveAndGradeSubmission(submission, variant, question, course, callback) {
        debug('saveAndGradeSubmission()');
        let submission_id;
        sqldb.beginTransaction((err, client, done) => {
            if (ERR(err, callback)) return;
            async.series([
                (callback) => {
                    this._saveSubmissionWithClient(client, submission, variant, question, course, (err, ret_submission_id) => {
                        if (ERR(err, callback)) return;
                        submission_id = ret_submission_id;
                        debug('saveAndGradeSubmission()', 'submission_id:', submission_id);
                        callback(null);
                    });
                },
                (callback) => {
                    this._gradeVariantWithClient(client, variant, submission_id, question, course, submission.auth_user_id, (err) => {
                        if (ERR(err, callback)) return;
                        debug('saveAndGradeSubmission()', 'graded');
                        callback(null);
                    });
                },
            ], (err) => {
                sqldb.endTransaction(client, done, err, (err) => {
                    if (ERR(err, callback)) return;
                    debug('saveAndGradeSubmission()', 'returning submission_id:', submission_id);
                    callback(null, submission_id);
                });
            });
        });
    },

    /**
     * Internal worker. Do not call directly. Renders the HTML for a variant.
     * @protected
     *
     * @param {Object} renderSelection - Specify which panels should be rendered.
     * @param {Object} variant - The variant to submit to.
     * @param {Object} question - The question for the variant.
     * @param {Object} submission - The current submission to the variant.
     * @param {Array} submissions - The full list of submissions to the variant.
     * @param {Object} course - The course for the variant.
     * @param {Object} locals - The current locals for the page response.
     * @param {function} callback - A callback(err, courseErrs, htmls) function.
     */
    _render(renderSelection, variant, question, submission, submissions, course, locals, callback) {
        questionServers.getModule(question.type, (err, questionModule) => {
            if (ERR(err, callback)) return;
            questionModule.render(renderSelection, variant, question, submission, submissions, course, locals, (err, courseErrs, htmls) => {
                if (ERR(err, callback)) return;
                
                const studentMessage = 'Error rendering question';
                const courseData = {variant, question, submission, course};
                this._writeCourseErrs(null, courseErrs, variant.id, locals.authn_user.user_id, studentMessage, courseData, (err) => {
                    if (ERR(err, callback)) return;
                    return callback(null, htmls);
                });
            });
        });
    },

    /**
     * Render all information needed for a question.
     * 
     * @param {?number} variant_id - The variant to render, or null if it should be generated.
     * @param {Object} locals - The current locals structure to read/write.
     * @param {function} callback - A callback(err) function.
     */
    getAndRenderVariant(variant_id, locals, callback) {
        locals.showGradeButton = false;
        locals.showSaveButton = false;
        locals.showNewVariantButton = false;
        locals.tryAgainButton = false;
        locals.showSubmissions = false;
        locals.showFeedback = false;
        locals.showTrueAnswer = false;
        locals.showGradingRequested = false;
        locals.allowAnswerEditing = false;
        locals.submissions = [];

        if (!locals.assessment) {
            // instructor question pages
            locals.showGradeButton = true;
            locals.showSaveButton = true;
            locals.allowAnswerEditing = true;
            locals.showNewVariantButton = true;
        } else {
            // student question pages
            if (locals.assessment.type == 'Homework') {
                locals.showGradeButton = true;
                locals.showSaveButton = true;
                locals.allowAnswerEditing = true;
            }
            if (locals.assessment.type == 'Exam') {
                if (locals.assessment_instance.open) {
                    if (locals.instance_question.open) {
                        locals.showSaveButton = true;
                        locals.allowAnswerEditing = true;
                    }
                } else {
                    locals.showTrueAnswer = true;
                }
            }
        }

        async.series([
            (callback) => {
                if (variant_id != null) {
                    sqldb.callOneRow('variants_select', [variant_id], (err, result) => {
                        if (ERR(err, callback)) return;
                        locals.variant = result.rows[0];
                        callback(null);
                    });
                } else {
                    const require_open = (locals.assessment && locals.assessment.type != 'Exam');
                    const instance_question_id = locals.instance_question ? locals.instance_question.id : null;
                    this.ensureVariant(locals.question.id, instance_question_id, locals.user.user_id, locals.authn_user.user_id, locals.course, {}, require_open, (err, variant) => {
                        if (ERR(err, callback)) return;
                        locals.variant = variant;
                        callback(null);
                    });
                }
            },
            (callback) => {
                if (!locals.assessment) {
                    // instructor question pages
                    const questionUrl = locals.urlPrefix + '/question/' + locals.question.id + '/';
                    locals.newVariantUrl = questionUrl;
                    locals.tryAgainUrl = questionUrl;
                    locals.reloadUrl = questionUrl;
                    locals.clientFilesQuestionUrl = questionUrl + 'clientFilesQuestion';
                    locals.calculationQuestionFileUrl = questionUrl + 'file';
                    locals.calculationQuestionGeneratedFileUrl = questionUrl + 'generatedFilesQuestion';
                } else {
                    // student question pages
                    const iqUrl = locals.urlPrefix + '/instance_question/' + locals.instance_question.id;
                    locals.newVariantUrl = iqUrl;
                    locals.tryAgainUrl = iqUrl;
                    locals.reloadUrl = iqUrl + '/?variant_id=' + locals.variant.id;
                    locals.clientFilesQuestionUrl = iqUrl + '/clientFilesQuestion';
                    locals.calculationQuestionFileUrl = iqUrl + '/file';
                    locals.calculationQuestionGeneratedFileUrl = iqUrl + '/generatedFilesQuestion/variant/' + locals.variant.id;
                }
                callback(null);
            },
            (callback) => {
                locals.showFeedback = true;
                if (!locals.variant.open
                    || (locals.instance_question && !locals.instance_question.open)
                    || (locals.assessment_instance && !locals.assessment_instance.open)) {
                    locals.showGradeButton = false;
                    locals.showSaveButton = false;
                    locals.allowAnswerEditing = false;
                    if (locals.assessment && locals.assessment.type == 'Homework') {
                        locals.tryAgainButton = true;
                        locals.showTrueAnswer = true;
                    }
                }
                callback(null);
            },
            (callback) => {
                var params = {
                    variant_id: locals.variant.id,
                    req_date: locals.req_date,
                };
                sqldb.query(sql.select_submissions, params, (err, result) => {
                    if (ERR(err, callback)) return;
                    if (result.rowCount >= 1) {
                        locals.submissions = result.rows;
                        locals.submission = locals.submissions[0]; // most recent submission

                        locals.showSubmissions = true;
                    }
                    callback(null);
                });
            },
            (callback) => {
                if (locals.variant.broken) {
                    locals.showGradeButton = false;
                    locals.showSaveButton = false;
                    if (locals.assessment && locals.assessment.type == 'Homework') {
                        locals.tryAgainButton = true;
                    }
                }
                callback(null);
            },
            (callback) => {
                questionServers.getEffectiveQuestionType(locals.question.type, (err, eqt) => {
                    if (ERR(err, callback)) return;
                    locals.effectiveQuestionType = eqt;
                    callback(null);
                });
            },
            (callback) => {
                const renderSelection = {
                    'header': true,
                    'question': true,
                    'submissions': locals.showSubmissions,
                    'answer': locals.showTrueAnswer,
                };
                this._render(renderSelection, locals.variant, locals.question, locals.submission, locals.submissions, locals.course, locals, (err, htmls) => {
                    if (ERR(err, callback)) return;
                    locals.extraHeadersHtml = htmls.extraHeadersHtml;
                    locals.questionHtml = htmls.questionHtml;
                    locals.submissionHtmls = htmls.submissionHtmls;
                    locals.answerHtml = htmls.answerHtml;
                    callback(null);
                });
            },
            (callback) => {
                // load errors last in case there are errors from rendering
                const params = {
                    variant_id: locals.variant.id,
                };
                sqldb.query(sql.select_errors, params, (err, result) => {
                    if (ERR(err, callback)) return;
                    locals.errors = result.rows;
                    callback(null);
                });
            },
            (callback) => {
                var questionJson = JSON.stringify({
                    questionFilePath: locals.calculationQuestionFileUrl,
                    questionGeneratedFilePath: locals.calculationQuestionGeneratedFileUrl,
                    question: locals.question,
                    effectiveQuestionType: locals.effectiveQuestionType,
                    course: locals.course,
                    courseInstance: locals.course_instance,
                    variant: {
                        id: locals.variant.id,
                        params: locals.variant.params,
                    },
                    submittedAnswer: (locals.showSubmissions && locals.submission) ? locals.submission.submitted_answer : null,
                    feedback: (locals.showFeedback && locals.submission) ? locals.submission.feedback : null,
                    trueAnswer: locals.showTrueAnswer ? locals.variant.true_answer : null,
                    submissions : locals.showSubmissions ? locals.submissions : null,
                });
                var encodedJson = encodeURIComponent(questionJson);
                locals.questionJsonBase64 = (new Buffer(encodedJson)).toString('base64');
                locals.video = null;
                callback(null);
            },
        ], (err) => {
            if (ERR(err, callback)) return;
            callback(null);
        });
    },
};