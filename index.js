'use strict';

const { HanaVectorPublisher, DEFAULTS } = require('./lib/HanaVectorPublisher');
const { chunkText, normalizeText } = require('./lib/chunker');
const { extractText, detectFileType, SUPPORTED_TYPES } = require('./lib/extractors');
const { HanaVectorPublisherError, ERROR_CODES } = require('./lib/errors');
const { toBuffer } = require('./lib/utils');

module.exports = HanaVectorPublisher;
module.exports.HanaVectorPublisher = HanaVectorPublisher;
module.exports.DEFAULTS = DEFAULTS;
module.exports.chunkText = chunkText;
module.exports.normalizeText = normalizeText;
module.exports.extractText = extractText;
module.exports.detectFileType = detectFileType;
module.exports.SUPPORTED_TYPES = SUPPORTED_TYPES;
module.exports.HanaVectorPublisherError = HanaVectorPublisherError;
module.exports.ERROR_CODES = ERROR_CODES;
module.exports.toBuffer = toBuffer;
