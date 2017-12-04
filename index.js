var request = require('request');
var FeatureStoreEventWrapper = require('./feature_store_event_wrapper');
var InMemoryFeatureStore = require('./feature_store');
var RedisFeatureStore = require('./redis_feature_store');
var Requestor = require('./requestor');
var EventEmitter = require('events').EventEmitter;
var PollingProcessor = require('./polling');
var StreamingProcessor = require('./streaming');
var evaluate = require('./evaluate_flag');
var tunnel = require('tunnel');
var winston = require('winston');
var crypto = require('crypto');
var async = require('async');
var errors = require('./errors');
var package_json = require('./package.json');

/**
 * Wrap a promise to invoke an optional callback upon resolution or rejection.
 * 
 * This function assumes the callback follows the Node.js callback type: (err, value) => void
 * 
 * If a callback is provided:
 *   - if the promise is resolved, invoke the callback with (null, value)
 *   - if the promise is rejected, invoke the callback with (error, null)
 * 
 * @param {Promise<any>} promise 
 * @param {Function} callback 
 * @returns Promise<any>
 */
function wrapPromiseCallback(promise, callback) {
  if (callback) {
    return promise.then(
      function(value) {
        setTimeout(function() { callback(null, value); }, 0);
      },
      function(error) {
        setTimeout(function() { callback(error, null); }, 0);
      }
    );
  }

  return promise;
}

function createErrorReporter(emitter, logger) {
  return function(error) {
    if (!error) {
      return;
    }

    if (emitter.listenerCount('error')) {
      emitter.emit('error', error);
    } else {
      logger.error(error);
    }
  };
}

global.setImmediate = global.setImmediate || process.nextTick.bind(process);

var new_client = function(sdk_key, config) {
  var client = new EventEmitter(),
      init_complete = false,
      queue = [],
      requestor,
      update_processor;

  config = config || {};
  config.user_agent = 'NodeJSClient/' + package_json.version;
  
  config.base_uri = (config.base_uri || 'https://app.launchdarkly.com').replace(/\/+$/, "");
  config.stream_uri = (config.stream_uri || 'https://stream.launchdarkly.com').replace(/\/+$/, "");
  config.events_uri = (config.events_uri || 'https://events.launchdarkly.com').replace(/\/+$/, "");
  config.stream = (typeof config.stream === 'undefined') ? true : config.stream;
  config.timeout = config.timeout || 5;
  config.capacity = config.capacity || 1000;
  config.flush_interval = config.flush_interval || 5;  
  config.poll_interval = config.poll_interval > 1 ? config.poll_interval : 1;
  // Initialize global tunnel if proxy options are set
  if (config.proxy_host && config.proxy_port ) {
    config.proxy_agent = create_proxy_agent(config);
  }
  config.logger = (config.logger || 
    new winston.Logger({
      level: 'debug',
      transports: [
        new (winston.transports.Console)(({
          formatter: function(options) {
            return '[LaunchDarkly] ' + (options.message ? options.message : '');
          }
        })),
      ]
    })
  );

  var featureStore = config.feature_store || InMemoryFeatureStore();
  config.feature_store = FeatureStoreEventWrapper(featureStore, client);

  var maybeReportError = createErrorReporter(client, config.logger);

  if (!sdk_key && !config.offline) {
    throw new Error("You must configure the client with an SDK key");
  }

  if (!config.use_ldd && !config.offline) {
    requestor = Requestor(sdk_key, config);

    if (config.stream) {
      config.logger.info("Initializing stream processor to receive feature flag updates");
      update_processor = StreamingProcessor(sdk_key, config, requestor);
    } else {
      config.logger.info("Initializing polling processor to receive feature flag updates");
      update_processor = PollingProcessor(config, requestor);
    }
    update_processor.start(function(err) {
      if (err) {
        var error;
        if ((err.status && err.status === 401) || (err.code && err.code === 401)) {
          error = new Error("Authentication failed. Double check your SDK key.");
        } else {
          error = err;
        }
        
        maybeReportError(error);
      } else if (!init_complete) {
        init_complete = true;        
        client.emit('ready');
      }
    });
  } else {
    process.nextTick(function() {
      init_complete = true;
      client.emit('ready');
    });
  }

  client.initialized = function() {
    return init_complete;
  }

  client.waitUntilReady = function() {
    return new Promise(function(resolve) {
      client.once('ready', resolve);
    });
  };

  client.variation = function(key, user, default_val, callback) {
    return wrapPromiseCallback(new Promise(function(resolve, reject) {
      sanitize_user(user);
      var variationErr;

      if (this.is_offline()) {
        config.logger.info("Variation called in offline mode. Returning default value.");
        return resolve(default_val);
      }

      else if (!key) {
        variationErr = new errors.LDClientError('No feature flag key specified. Returning default value.');
        maybeReportError(variationError);
        send_flag_event(key, user, default_val, default_val);
        return resolve(default_val);
      }

      else if (!user) {
        variationErr = new errors.LDClientError('No user specified. Returning default value.');
        maybeReportError(variationErr);
        send_flag_event(key, user, default_val, default_val);
        return resolve(default_val);
      }

      else if (user.key === "") {
        config.logger.warn("User key is blank. Flag evaluation will proceed, but the user will not be stored in LaunchDarkly");
      }

      if (!init_complete) {
        if (config.feature_store.initialized()) {
          config.logger.warn("Variation called before LaunchDarkly client initialization completed (did you wait for the 'ready' event?) - using last known values from feature store")
        } else {
          variationErr = new errors.LDClientError("Variation called before LaunchDarkly client initialization completed (did you wait for the 'ready' event?) - using default value");
          maybeReportError(variationErr);
          send_flag_event(key, user, default_val, default_val);
          return resolve(default_val);
        }
      }

      config.feature_store.get(key, function(flag) {
        evaluate.evaluate(flag, user, config.feature_store, function(err, result, events) {
          var i;
          var version = flag ? flag.version : null;

          if (err) {
            maybeReportError(new errors.LDClientError('Encountered error evaluating feature flag:' + (err.message ? (': ' + err.message) : err)));
          }

          // Send off any events associated with evaluating prerequisites. The events
          // have already been constructed, so we just have to push them onto the queue.
          if (events) {
            for (i = 0; i < events.length; i++) {
              enqueue(events[i]);
            }
          }

          if (result === null) {
            config.logger.debug("Result value is null in variation");
            send_flag_event(key, user, default_val, default_val, version);
            return resolve(default_val);
          } else {
            send_flag_event(key, user, result, default_val, version);
            return resolve(result);
          }               
        });
      });
    }.bind(this)), callback);
  }

  client.toggle = function(key, user, default_val, callback) {
    config.logger.warn("toggle() is deprecated. Call 'variation' instead");
    return client.variation(key, user, default_val, callback);
  }

  client.all_flags = function(user, callback) {
    return wrapPromiseCallback(new Promise(function(resolve, reject) {
      sanitize_user(user);
      var results = {};

      if (this.is_offline() || !user) {
        config.logger.info("all_flags() called in offline mode. Returning empty map.");
        return resolve({});
      }

      config.feature_store.all(function(flags) {
        async.forEachOf(flags, function(flag, key, iteratee_cb) {
          // At the moment, we don't send any events here
          evaluate.evaluate(flag, user, config.feature_store, function(err, result, events) {
            results[key] = result;
            iteratee_cb(null);
          })
        }, function(err) {
          return err ? reject(err) : resolve(results);
        });
      });
    }.bind(this)), callback);
  }

  client.secure_mode_hash = function(user) {
    var hmac = crypto.createHmac('sha256', sdk_key);
    hmac.update(user.key);
    return hmac.digest('hex');
  }

  client.close = function() {
    if (update_processor) {
      update_processor.close();
    }
    config.feature_store.close();
  }

  client.is_offline = function() {
    return config.offline;
  }

  client.track = function(eventName, user, data) {
    sanitize_user(user);
    var event = {"key": eventName, 
                "user": user,
                "kind": "custom", 
                "creationDate": new Date().getTime()};

    if (data) {
      event.data = data;
    }

    enqueue(event);
  };

  client.identify = function(user) {
    sanitize_user(user);
    var event = {"key": user.key,
                 "kind": "identify",
                 "user": user,
                 "creationDate": new Date().getTime()};
    enqueue(event);
  };

  client.flush = function(callback) {
    return wrapPromiseCallback(new Promise(function(resolve, reject) {
      var worklist;
      if (!queue.length) {
        resolve();
      }

      worklist = queue.slice(0);
      queue = [];

      config.logger.debug("Flushing %d events", worklist.length);

      request({
        method: "POST",
        url: config.events_uri + '/bulk',
        headers: {
          'Authorization': sdk_key,
          'User-Agent': config.user_agent
        },
        json: true,
        body: worklist,
        timeout: config.timeout * 1000,
        agent: config.proxy_agent
      }).on('response', resolve)
        .on('error', reject);
    }.bind(this)), callback);
  };

  function enqueue(event) {
    if (config.offline) {
      return;
    }

    config.logger.debug("Sending flag event", JSON.stringify(event));
    queue.push(event);

    if (queue.length >= config.capacity) {
      client.flush();
    } 
  }

  function send_flag_event(key, user, value, default_val, version) {
    var event = evaluate.create_flag_event(key, user, value, default_val, version);
    enqueue(event);
  }

  // TODO keep the reference and stop flushing after close
  setInterval(client.flush.bind(client), config.flush_interval * 1000).unref();

  return client;
};

module.exports = {
  init: new_client,
  RedisFeatureStore: RedisFeatureStore,
  errors: errors
};


function create_proxy_agent(config) {
  var options = {
    proxy: {
      host: config.proxy_host,
      port: config.proxy_port,
      proxyAuth: config.proxy_auth
    } 
  };

  if (config.proxy_scheme === 'https') {
    if (!config.base_uri || config.base_uri.startsWith('https')) {
     return tunnel.httpsOverHttps(options);      
    } else {
      return tunnel.httpOverHttps(options);
    }
  } else if (!config.base_uri || config.base_uri.startsWith('https')) {
    return tunnel.httpsOverHttp(options);
  } else {
    return tunnel.httpOverHttp(options);
  }
}


function sanitize_user(u) {
  if (!u) {
    return;
  }
  if (u['key']) {
    u['key'] = u['key'].toString();
  }
}
