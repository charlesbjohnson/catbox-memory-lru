'use strict';

// Load modules

var Hoek = require('hoek');
var LRUCache = require('lru-cache');


// Declare internals

var internals = {};


internals.defaults = {
    allowMixedContent: false,
    lru: {
        max: 100 * 1024 * 1024, // 100MB
        length: function (envelope) {
            var value = envelope.item;

            if (Buffer.isBuffer(value)) {
                return value.length;
            }

            return Buffer.byteLength(value);
        }
    }
};


internals.Envelope = function (key, value, ttl, settings) {

    this.item = internals.serialize(value, settings.allowMixedContent);

    this.stored = Date.now();
    this.ttl = ttl;

    this.timeoutId = null;

    return this;
};


internals.serialize = function (value, allowMixedContent) {

    var item = null;

    // copy/marshal to prevent value from changing while in the cache
    if (allowMixedContent && Buffer.isBuffer(value)) {
        item = new Buffer(value.length);
        value.copy(item);
    } else {
        item = JSON.stringify(value);
    }

    return item;
};


internals.deserialize = function (item) {

    if (Buffer.isBuffer(item)) {
        return {value: item};
    }

    var value = null;

    try {
        value = JSON.parse(item);
    } catch (err) {
        return {error: true};
    }

    return {value: value};
};


exports = module.exports = internals.Connection = function (options) {
    Hoek.assert(this.constructor === internals.Connection, 'LRU Memory cache client must be instantiated using new');
    Hoek.assert(!options || options.allowMixedContent === undefined || typeof options.allowMixedContent === 'boolean', 'Invalid allowMixedContent value');
    Hoek.assert(!options || Hoek.reach(options, 'lru.maxAge') === undefined, 'Invalid lru-cache maxAge configuration, use catbox.Policy configuration');

    this.settings = Hoek.applyToDefaults(internals.defaults, options);
    this.cache = null;

    return this;
};


internals.Connection.prototype.start = function (callback) {

    callback = Hoek.nextTick(callback);

    if (!this.cache) {
        this.cache = new LRUCache(this.settings.lru);
    }

    return callback();
};


internals.Connection.prototype.stop = function () {

    this.cache.forEach(function (value) {
        clearTimeout(value.timeoutId);
    });

    this.cache.reset();
    this.cache = null;

    return;
};


internals.Connection.prototype.isReady = function () {

    return Boolean(this.cache);
};


internals.Connection.prototype.validateSegmentName = function (name) {

    if (!name) {
        return new Error('Empty string');
    }

    if (name.indexOf('\u0000') !== -1) {
        return new Error('Includes null character');
    }

    return null;
};


internals.Connection.prototype.get = function (key, callback) {

    callback = Hoek.nextTick(callback);

    if (!this.cache) {
        return callback(new Error('Connection not started'));
    }

    var cacheKey = this.generateKey(key);
    var envelope = this.cache.get(cacheKey);

    if (!envelope) {
        return callback(null, null);
    }

    var deserialized = internals.deserialize(envelope.item);

    if (deserialized.error) {
        return callback(new Error('Bad value content'));
    }

    var result = {
        item: deserialized.value,
        stored: envelope.stored,
        ttl: envelope.ttl
    };

    return callback(null, result);
};


internals.Connection.prototype.set = function (key, value, ttl, callback) {

    var self = this;

    callback = Hoek.nextTick(callback);

    if (!this.cache) {
        return callback(new Error('Connection not started'));
    }

    if (ttl > 2147483647) {
        // See https://github.com/nodejs/node/blob/bb1bd7639554766a88b8f7aef8891bf8249e613e/lib/timers.js#L11
        return callback(new Error('Invalid ttl (greater than 2147483647)'));
    }

    var envelope = null;
    try {
        envelope = new internals.Envelope(key, value, ttl, this.settings);
    } catch (err) {
        return callback(err);
    }

    var cacheKey = this.generateKey(key);
    var cachedItem = this.cache.peek(cacheKey);

    if (cachedItem && cachedItem.timeoutId) {
        clearTimeout(cachedItem.timeoutId);
    }

    var timeoutId = setTimeout(function () {
        self.drop(key, function () { });
    }, ttl);

    envelope.timeoutId = timeoutId;

    this.cache.set(cacheKey, envelope);

    return callback();
};


internals.Connection.prototype.drop = function (key, callback) {

    callback = Hoek.nextTick(callback);

    if (!this.cache) {
        return callback(new Error('Connection not started'));
    }

    var cacheKey = this.generateKey(key);
    this.cache.del(cacheKey);

    return callback();
};


internals.Connection.prototype.generateKey = function (key) {

    return key.segment + ':' + key.id;
};
