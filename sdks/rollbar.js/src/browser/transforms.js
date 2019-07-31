var _ = require('../utility');
var errorParser = require('./errorParser');
var logger = require('./logger');

function handleItemWithError(item, options, callback) {
  item.data = item.data || {};
  if (item.err) {
    try {
      item.stackInfo = item.err._savedStackTrace || errorParser.parse(item.err);
    } catch (e) {
      logger.error('Error while parsing the error object.', e);
      try {
        item.message = item.err.message || item.err.description || item.message || String(item.err);
      } catch (e2) {
        item.message = String(item.err) || String(e2);
      }
      delete item.err;
    }
  }
  callback(null, item);
}

function ensureItemHasSomethingToSay(item, options, callback) {
  if (!item.message && !item.stackInfo && !item.custom) {
    callback(new Error('No message, stack info, or custom data'), null);
  }
  callback(null, item);
}

function addBaseInfo(item, options, callback) {
  var environment = (options.payload && options.payload.environment) || options.environment;
  item.data = _.merge(item.data, {
    environment: environment,
    level: item.level,
    endpoint: options.endpoint,
    platform: 'browser',
    framework: 'browser-js',
    language: 'javascript',
    server: {},
    uuid: item.uuid,
    notifier: {
      name: 'rollbar-browser-js',
      version: options.version
    }
  });
  callback(null, item);
}

function addRequestInfo(window) {
  return function(item, options, callback) {
    if (!window || !window.location) {
      return callback(null, item);
    }
    var remoteString = '$remote_ip';
    if (!options.captureIp) {
      remoteString = null;
    } else if (options.captureIp !== true) {
      remoteString += '_anonymize';
    }
    _.set(item, 'data.request', {
      url: window.location.href,
      query_string: window.location.search,
      user_ip: remoteString
    });
    callback(null, item);
  };
}

function addClientInfo(window) {
  return function(item, options, callback) {
    if (!window) {
      return callback(null, item);
    }
    var nav = window.navigator || {};
    var scr = window.screen || {};
    _.set(item, 'data.client', {
      runtime_ms: item.timestamp - window._rollbarStartTime,
      timestamp: Math.round(item.timestamp / 1000),
      javascript: {
        browser: nav.userAgent,
        language: nav.language,
        cookie_enabled: nav.cookieEnabled,
        screen: {
          width: scr.width,
          height: scr.height
        }
      }
    });
    callback(null, item);
  };
}

function addPluginInfo(window) {
  return function(item, options, callback) {
    if (!window || !window.navigator) {
      return callback(null, item);
    }
    var plugins = [];
    var navPlugins = window.navigator.plugins || [];
    var cur;
    for (var i=0, l=navPlugins.length; i < l; ++i) {
      cur = navPlugins[i];
      plugins.push({name: cur.name, description: cur.description});
    }
    _.set(item, 'data.client.javascript.plugins', plugins);
    callback(null, item);
  };
}

function addBody(item, options, callback) {
  if (item.stackInfo) {
    addBodyTrace(item, options, callback);
  } else {
    addBodyMessage(item, options, callback);
  }
}

function addBodyMessage(item, options, callback) {
  var message = item.message;
  var custom = item.custom;

  if (!message) {
    message = 'Item sent with null or missing arguments.';
  }
  var result = {
    body: message
  };

  if (custom) {
    result.extra = _.merge(custom);
  }

  _.set(item, 'data.body', {message: result});
  callback(null, item);
}


function addBodyTrace(item, options, callback) {
  var description = item.data.description;
  var stackInfo = item.stackInfo;
  var custom = item.custom;

  var guess = errorParser.guessErrorClass(stackInfo.message);
  var className = stackInfo.name || guess[0];
  var message = guess[1];
  var trace = {
    exception: {
      'class': className,
      message: message
    }
  };

  if (description) {
    trace.exception.description = description;
  }

  // Transform a TraceKit stackInfo object into a Rollbar trace
  var stack = stackInfo.stack;
  if (stack && stack.length === 0 && item._unhandledStackInfo && item._unhandledStackInfo.stack) {
    stack = item._unhandledStackInfo.stack;
  }
  if (stack) {
    if (stack.length === 0) {
      trace.exception.stack = stackInfo.rawStack;
      trace.exception.raw = String(stackInfo.rawException);
    }
    var stackFrame;
    var frame;
    var code;
    var pre;
    var post;
    var contextLength;
    var i, mid;

    trace.frames = [];
    for (i = 0; i < stack.length; ++i) {
      stackFrame = stack[i];
      frame = {
        filename: stackFrame.url ? _.sanitizeUrl(stackFrame.url) : '(unknown)',
        lineno: stackFrame.line || null,
        method: (!stackFrame.func || stackFrame.func === '?') ? '[anonymous]' : stackFrame.func,
        colno: stackFrame.column
      };
      if (options.sendFrameUrl) {
        frame.url = stackFrame.url;
      }
      if (frame.method && frame.method.endsWith && frame.method.endsWith('_rollbar_wrapped')) {
        continue;
      }

      code = pre = post = null;
      contextLength = stackFrame.context ? stackFrame.context.length : 0;
      if (contextLength) {
        mid = Math.floor(contextLength / 2);
        pre = stackFrame.context.slice(0, mid);
        code = stackFrame.context[mid];
        post = stackFrame.context.slice(mid);
      }

      if (code) {
        frame.code = code;
      }

      if (pre || post) {
        frame.context = {};
        if (pre && pre.length) {
          frame.context.pre = pre;
        }
        if (post && post.length) {
          frame.context.post = post;
        }
      }

      if (stackFrame.args) {
        frame.args = stackFrame.args;
      }

      trace.frames.push(frame);
    }

    // NOTE(cory): reverse the frames since rollbar.com expects the most recent call last
    trace.frames.reverse();

    if (custom) {
      trace.extra = _.merge(custom);
    }
    _.set(item, 'data.body', {trace: trace});
    callback(null, item);
  } else {
    item.message = className + ': ' + message;
    addBodyMessage(item, options, callback);
  }
}

function scrubPayload(item, options, callback) {
  var scrubFields = options.scrubFields;
  item.data = _.scrub(item.data, scrubFields);
  callback(null, item);
}

module.exports = {
  handleItemWithError: handleItemWithError,
  ensureItemHasSomethingToSay: ensureItemHasSomethingToSay,
  addBaseInfo: addBaseInfo,
  addRequestInfo: addRequestInfo,
  addClientInfo: addClientInfo,
  addPluginInfo: addPluginInfo,
  addBody: addBody,
  scrubPayload: scrubPayload
};
