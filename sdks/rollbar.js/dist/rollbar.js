(function(window, document){

// Updated by the build process to match package.json
Notifier.VERSION = '0.10.8';
Notifier.DEFAULT_ENDPOINT = 'https://api.rollbar.com/api/1/item/';
Notifier.DEFAULT_SCRUB_FIELDS = ["passwd","password","secret","confirm_password","password_confirmation"];

// This is the global queue where all notifiers will put their
// payloads to be sent to Rollbar.
window._rollbarPayloadQueue = [];

// This contains global options for all Rollbar notifiers.
window._globalRollbarOptions = {
  startTime: (new Date()).getTime(),
};


function Notifier(parentNotifier) {
  this.options = {
    endpoint: Notifier.DEFAULT_ENDPOINT,
    scrubFields: Util.copy(Notifier.DEFAULT_SCRUB_FIELDS),
    payload: {}
  };

  this.plugins = {};
  this.parentNotifier = parentNotifier;

  if (parentNotifier) {
    // If the parent notifier has the shimId
    // property it means that it's a Rollbar shim.
    if (parentNotifier.hasOwnProperty('shimId')) {
      // After we set this, the shim is just a proxy to this
      // Notifier instance.
      parentNotifier.notifier = this;
    } else {
      this.configure(parentNotifier.options);
    }
  }
}


Notifier._generateLogFn = function(level) {
  return function() {
    var args = this._getLogArgs(arguments);

    return this._log(level || args.level || this.options.defaultLogLevel || 'debug',
        args.message, args.err, args.custom, args.callback);
  };
};


/*
 * Returns an Object with keys:
 * {
 *  message: String,
 *  err: Error,
 *  custom: Object
 * }
 */
Notifier.prototype._getLogArgs = function(args) {
  var level = this.options.defaultLogLevel || 'debug';
  var ts;
  var message;
  var err;
  var custom;
  var callback;

  var argT;
  var arg;
  for (var i = 0; i < args.length; ++i) {
    arg = args[i];
    argT = typeof arg;
    if (argT === 'string') {
      message = arg;
    } else if (argT === 'function') {
      callback = arg;
    } else if (argT === 'object') {
      if (arg.constructor.name === 'Date') {
        ts = arg;
      } else if (arg.hasOwnProperty('stack')) {
        err = arg;
      } else {
        custom = arg;
      }
    }
  }

  // TODO(cory): somehow pass in timestamp too...
  
  return {
    level: level,
    message: message,
    err: err,
    custom: custom,
    callback: callback
  };
};


Notifier.prototype._route = function(path) {
  var endpoint = this.options.endpoint || Notifier.DEFAULT_ENDPOINT;

  if (/\/$/.test(endpoint) && /^\//.test(path)) {
    path = path.substring(1);
  } else if (!(/\/$/.test(endpoint)) && !(/^\//.test(path))) {
    path = '/' + path;
  }

  return endpoint + path;
};


/*
 * Given a queue containing each call to the shim, call the
 * corresponding method on this instance.
 *
 * shim queue contains:
 *
 * {shim: Rollbar, method: 'info', args: ['hello world', exc], ts: Date}
 */
Notifier.prototype._processShimQueue = function(shimQueue) {
  // implement me
  var shim;
  var obj;
  var tmp;
  var method;
  var args;
  var shimToNotifier = {};
  var parentShim;
  var parentNotifier;
  var notifier;

  // For each of the messages in the shimQueue we need to:
  // 1. get/create the notifier for that shim
  // 2. apply the message to the notifier
  while ((obj = shimQueue.shift())) {
    shim = obj.shim;
    method = obj.method;
    args = obj.args;
    parentShim = shim.parentShim;

    // Get the current notifier based on the shimId
    notifier = shimToNotifier[shim.shimId];
    if (!notifier) {

      // If there is no notifier associated with the shimId
      // Check to see if there's a parent shim
      if (parentShim) {

        // If there is a parent shim, get the parent notifier
        // and create a new notifier for the current shim.
        parentNotifier = shimToNotifier[parentShim.shimId];

        // Create a new Notifier which will process all of the shim's
        // messages
        notifier = new Notifier(parentNotifier);
      } else {
        // If there is no parent, assume the shim is the top
        // level shim and thus, should use this as the notifier.
        notifier = this;
      }

      // Save off the shimId->notifier mapping
      shimToNotifier[shim.shimId] = notifier;
    }

    if (notifier[method] && typeof notifier[method] === 'function') {
      notifier[method].apply(notifier, args);
    }
  }
};


/*
 * Builds and returns an Object that will be enqueued onto the
 * window._rollbarPayloadQueue array to be sent to Rollbar.
 */
Notifier.prototype._buildPayload = function(ts, level, message, err, custom, callback) {
  var accessToken = this.options.accessToken;
  var environment = this.options.environment;

  var notifierOptions = Util.copy(this.options.payload);
  var uuid = Util.uuid4();

  var payloadData = {
    environment: environment,
    endpoint: this.options.endpoint,
    uuid: uuid,
    level: level,
    platform: 'browser',
    framework: 'browser-js',
    language: 'javascript',
    body: this._buildBody(message, err),
    request: {
      url: window.location.href,
      query_string: window.location.search,
      user_ip: "$remote_ip"
    },
    client: {
      runtime_ms: ts.getTime() - window._globalRollbarOptions.startTime,
      timestamp: Math.round(ts.getTime() / 1000),
      javascript: {
        browser: window.navigator.userAgent,
        language: window.navigator.language,
        cookie_enabled: window.navigator.cookieEnabled,
        screen: {
          width: window.screen.width,
          height: window.screen.height
        },
        plugins: this._getBrowserPlugins()
      }
    },
    server: {},
    notifier: {
      name: 'rollbar-browser-js',
      version: Notifier.VERSION
    }
  };

  // Overwrite the options from configure() with the payload
  // data.
  var payload = {
    access_token: accessToken,
    data: Util.merge(notifierOptions, payloadData)
  };

  if (custom) {
    Util.merge(payload.data, custom);
  }

  this._scrub(payload);

  return payload;
};


Notifier.prototype._buildBody = function(message, err) {
  var buildTrace = function(description, err) {
    var className = err.name || typeof err;
    var message = err.message || err.toString();
    var trace = {
      exception: {
        'class': className,
        message: err.message || err.toString()
      }
    };

    if (message) {
      trace.exception.description = description;
    }

    if (err.stack) {
      var st = new StackTrace(err);
      var frames = st.frames;
      if (frames) {
        trace.frames = frames;
      } 
    }

    if (!trace.frames) {
      // no frames - not useful as a trace. just report as a message.
      return buildMessage(className + ': ' + message);
    } else {
      return trace;
    }
  };

  var buildMessage = function(message) {
    return {
      message: {
        body: message
      }
    };
  };

  var body;
  if (err) {
    body = buildTrace(message, err);
  } else {
    body = buildMessage(message);  
  }
  return body;
};


Notifier.prototype._getBrowserPlugins = function() {
  if (!this._browserPlugins) {
    var navPlugins = (window.navigator.plugins || []);
    var cur;
    var numPlugins = navPlugins.length;
    var plugins = [];
    for (i = 0; i < numPlugins; ++i) {
      cur = navPlugins[i];
      plugins.push({name: cur.name, description: cur.description});
    }
    this._browserPlugins = plugins;
  }
  return this._browserPlugins;
};


/*
 * Does an in-place modification of obj such that:
 * 1. All keys that match the window._globalRollbarOptions.scrubParams
 *    list will be normalized into all '*'
 * 2. Any query string params that match the same criteria will have
 *    their values normalized as well.
 */
Notifier.prototype._scrub = function(obj) {
  var redactQueryParam = function(match, paramPart, dummy1,
      dummy2, dummy3, valPart, offset, string) {
    return paramPart + Util.redact(valPart);
  };

  var scrubFields = this.options.scrubFields;
  var paramRes = this._getScrubFieldRegexs(scrubFields);
  var queryRes = this._getScrubQueryParamRegexs(scrubFields);
  var paramScrubber = function(v) {
    var i;
    if (typeof(v) === 'string') {
      for (i = 0; i < queryRes.length; ++i) {
        v = v.replace(queryRes[i], redactQueryParam);
      }
    }
    return v;
  };

  var valScrubber = function(k, v) {
    var i;
    for (i = 0; i < paramRes.length; ++i) {
      if (paramRes[i].test(k)) {
        v = Util.redact(v);
        break;
      }
    }
    return v;
  };

  var scrubber = function(k, v) {
    var tmpV = valScrubber(k, v);
    if (tmpV === v) {
      return paramScrubber(tmpV);
    } else {
      return tmpV;
    }
  };

  Util.traverse(obj, scrubber);
  return obj;
};


Notifier.prototype._getScrubFieldRegexs = function(scrubFields) {
  var ret = [];
  var pat;
  for (var i = 0; i < scrubFields.length; ++i) {
    pat = '\\[?(%5[bB])?' + scrubFields[i] + '\\[?(%5[bB])?\\]?(%5[dD])?';
    ret.push(new RegExp(pat, 'i'));
  }
  return ret;
};


Notifier.prototype._getScrubQueryParamRegexs = function(scrubFields) {
  var ret = [];
  var pat;
  for (var i = 0; i < scrubFields.length; ++i) {
    pat = '\\[?(%5[bB])?' + scrubFields[i] + '\\[?(%5[bB])?\\]?(%5[dD])?';
    ret.push(new RegExp('(' + pat + '=)([^&\\n]+)', 'igm'));
  }
  return ret;
};


/*
 * Logs stuff to Rollbar and console.log using the default
 * logging level.
 *
 * Can be called with the following, (order doesn't matter but type does):
 * - message: String
 * - err: Error object, must have a .stack property or it will be
 *   treated as custom data
 * - custom: Object containing custom data to be sent along with
 *   the item
 * - callback: Function to call once the item is reported to Rollbar
 */
Notifier.prototype._log = function(level, message, err, custom, callback) {
  // Implement me
  console.log('IMPLEMENT ME', level, message, err, custom);
};

Notifier.prototype.log = Notifier._generateLogFn();
Notifier.prototype.debug = Notifier._generateLogFn('debug');
Notifier.prototype.info = Notifier._generateLogFn('info');
Notifier.prototype.warning = Notifier._generateLogFn('warning');
Notifier.prototype.error = Notifier._generateLogFn('error');
Notifier.prototype.critical = Notifier._generateLogFn('critical');

Notifier.prototype.uncaughtError = function(message, url, lineNo, colNo, err) {
  // Implement me
  console.log(message, url, lineNo, colNo, err);
};


Notifier.prototype.global = function(options) {
  Util.merge(window._globalRollbarOptions, options);
};


Notifier.prototype.configure = function(options) {
  // TODO(cory): only allow non-payload keys that we understand

  // Make a copy of the options object for this notifier
  Util.merge(this.options, options);
};

/*
 * Create a new Notifier instance which has the same options
 * as the current notifier + options to override them.
 */
Notifier.prototype.scope = function(payloadOptions) {
  var scopedNotifier = new Notifier(this);
  Util.merge(scopedNotifier.options.payload, payloadOptions);
  return scopedNotifier;
};

/*
 * Derived work from raven-js at https://github.com/lincolnloop/raven-js
 *
 * Requires Util.sanitizeUrl
 */

function StackTrace(exc) {
  var frames = [];

  if (exc.arguments && exc.stack) {
    frames = _parseChromeExc(exc);
  } else if (exc.stack) {
    if (exc.stack.indexOf('@') === -1) {
      frames = _parseChromeExc(exc);
    } else {
      frames = _parseFirefoxOrSafariExc(exc);
    }
  } else {
    var lineno = parseInt(typeof exc.line !== 'undefined' ? exc.line : exc.lineNumber, 10) || 0;
    var fileUrl = Util.sanitizeUrl((typeof exc.sourceURL !== 'undefined' ? exc.sourceURL : exc.fileName) || null);

    frames = [{filename: fileUrl, lineno: lineno}];
  }
  this.frames = frames.reverse();
}


function _parseChromeExc(e) {
  var chunks, fn, filename, lineno, colno,
      traceback = [],
      lines = e.stack.split('\n'),
      i, line, len = lines.length, frames = [];

  var lineNoRegex = /:([0-9]+(:([0-9]+))?)$/;

  // Skip the first line
  for (i = 1; i < len; ++i) {
    line = lines[i];
    chunks = line.replace(/^\s+|\s+$/g, '').slice(3);
    if (chunks === 'unknown source') {
      continue;
    } else {
      chunks = chunks.split(' ');
    }

    if (chunks.length > 2) {
      fn = chunks.slice(0, -1).join(' ');
      filename = chunks.slice(-1)[0];
      lineno = 0;
    } else if (chunks.length === 2) {
      fn = chunks[0];
      filename = chunks[1];
    } else {
      fn = null;
      filename = chunks[0];
    }

    if (filename && filename !== '(unknown source)') {
      if (filename[0] === '(') {
        filename = filename.slice(1, -1);
      }
      var lineNoMatch = lineNoRegex.exec(filename);
      if (lineNoMatch) {
        lineno = lineNoMatch[1];
        lineno = lineno.split(':');
        if (lineno.length > 1) {
          colno = parseInt(lineno[1], 10);
        } else {
          colno = null;
        }
        lineno = parseInt(lineno[0], 10);
        filename = Util.sanitizeUrl(filename.slice(0, filename.indexOf(lineNoMatch[0])));
      } else {
        lineno = 0;
        colno = null;
      }
    }

    frames.push({filename: filename, lineno: lineno, colno: colno, method: fn});
  } 
  return frames;
}


function _parseFirefoxOrSafariExc(e) {
  var chunks, fn, filename, lineno,
      traceback = [],
      lines = e.stack.split('\n'),
      i, line, len = lines.length, frames = [];

  for (i = 0; i < len; ++i) {
    line = lines[i];

    if (line) {
      chunks = line.split('@');
      if (chunks[0]) {
        fn = chunks[0].split('(');
        fn = (typeof fn[0] !== 'undefined' && String(fn[0]).length) ? fn[0] : null;
      } else {
        fn = null;
      }

      if (chunks.length > 1) {
        filename = chunks[1].split(':');
        lineno = parseInt(filename.slice(-1)[0], 10) || 0;
        filename = Util.sanitizeUrl(filename.slice(0, -1).join(':')) || '<native code>';
      } else if (chunks[0] === '[native code]') {
        fn = null;
        filename = '<native code>';
        lineno = 0;
      }
      
      var frame = {filename: filename, lineno: lineno, method: fn};
      
      // Firefox gives a column number for the first frame
      if (i === 0 && e.columnNumber) {
        // Add 1 to represent a column number starting from 1 since Firefox
        // provides a 0-based column number
        frame.colno = e.columnNumber + 1;
      }
      
      frames.push(frame);
    }
  }
  return frames;
}

var Util = {
  // modified from https://github.com/jquery/jquery/blob/master/src/core.js#L127
  merge: function() {
    var options, name, src, copy, copyIsArray, clone,
      target = arguments[0] || {},
      i = 1,
      length = arguments.length,
      deep = true;

    // Handle case when target is a string or something (possible in deep copy)
    if (typeof target !== "object" && typeof target !== 'function') {
      target = {};
    }

    for (; i < length; i++) {
      // Only deal with non-null/undefined values
      if ((options = arguments[i]) !== null) {
        // Extend the base object
        for (name in options) {
          src = target[name];
          copy = options[name];

          // Prevent never-ending loop
          if (target === copy) {
            continue;
          }

          // Recurse if we're merging plain objects or arrays
          if (deep && copy && (copy.constructor == Object || (copyIsArray = (copy.constructor == Array)))) {
            if (copyIsArray) {
              copyIsArray = false;
              clone = src && src.constructor == Array ? src : [];
            } else {
              clone = src && src.constructor == Object ? src : {};
            }

            // Never move original objects, clone them
            target[name] = Util.merge(clone, copy);
          // Don't bring in undefined values
          } else if (copy !== undefined) {
            target[name] = copy;
          }
        }
      }
    }

    // Return the modified object
    return target;
  },

  copy: function(obj) {
    var dest = {};
    Util.merge(dest, obj);
    return dest;
  },

  parseUriOptions: {
    strictMode: false,
    key: ["source","protocol","authority","userInfo","user","password","host","port","relative","path","directory","file","query","anchor"],
    q:   {
      name:   "queryKey",
      parser: /(?:^|&)([^&=]*)=?([^&]*)/g
    },
    parser: {
      strict: /^(?:([^:\/?#]+):)?(?:\/\/((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?))?((((?:[^?#\/]*\/)*)([^?#]*))(?:\?([^#]*))?(?:#(.*))?)/,
      loose:  /^(?:(?![^:@]+:[^:@\/]*@)([^:\/?#.]+):)?(?:\/\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/
    }
  },

  parseUri: function(str) {
    if (!str || (typeof str !== 'string' && !(str instanceof String))) {
      throw new Error('Util.parseUri() received invalid input');
    }

    var o = Util.parseUriOptions;
    var m = o.parser[o.strictMode ? "strict" : "loose"].exec(str);
    var uri = {};
    var i = 14;

    while (i--) {
      uri[o.key[i]] = m[i] || "";
    }

    uri[o.q.name] = {};
    uri[o.key[12]].replace(o.q.parser, function ($0, $1, $2) {
      if ($1) {
        uri[o.q.name][$1] = $2;
      }
    });

    return uri;
  },

  sanitizeUrl: function(url) {
    if (!url || (typeof url !== 'string' && !(url instanceof String))) {
      throw new Error('Util.sanitizeUrl() received invalid input');
    }

    var baseUrlParts = Util.parseUri(url);
    // remove a trailing # if there is no anchor
    if (baseUrlParts.anchor === '') {
      baseUrlParts.source = baseUrlParts.source.replace('#', '');
    }

    url = baseUrlParts.source.replace('?' + baseUrlParts.query, '');
    return url;
  },

  traverse: function(obj, func) {
    var k;
    var v;
    for (k in obj) {
      if (obj.hasOwnProperty(k)) {
        v = obj[k];
        if (v !== null && typeof(v) === 'object') {
          Util.traverse(v, func);
        } else {
          obj[k] = func.apply(Util, [k, v]);
        }
      }
    }
  },

  redact: function(val) {
    val = String(val);
    return new Array(val.length + 1).join('*');
  },

  // from http://stackoverflow.com/a/8809472/1138191
  uuid4: function() {
    var d = new Date().getTime();
    var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = (d + Math.random()*16)%16 | 0;
      d = Math.floor(d/16);
      return (c=='x' ? r : (r&0x7|0x8)).toString(16);
    });
    return uuid;
  }
};

var XHR = {
  XMLHttpFactories: [
      function () {return new XMLHttpRequest();},
      function () {return new ActiveXObject("Msxml2.XMLHTTP");},
      function () {return new ActiveXObject("Msxml3.XMLHTTP");},
      function () {return new ActiveXObject("Microsoft.XMLHTTP");}
  ],
  createXMLHTTPObject: function() {
    var xmlhttp = false;
    var factories = XHR.XMLHttpFactories;
    var i;
    var numFactories = factories.length;
    for (i = 0; i < numFactories; i++) {
      try {
        xmlhttp = factories[i]();
        break;
      } catch (e) {
        // pass
      }
    }
    return xmlhttp;
  },
  post: function(url, payload, callback) {
    var request = XHR.createXMLHTTPObject();
    if (request) {
      try {
        try {
          var onreadystatechange = function(args) {
            try {
              if (callback && onreadystatechange && request.readyState === 4) {
                onreadystatechange = undefined;

                if (request.status === 200) {
                  callback(null, request.responseText);
                } else if (typeof(request.status) === "number" &&
                            request.status >= 400  && request.status < 600) {
                  //return valid http status codes
                  callback(new Error(request.status.toString()));
                } else {
                  //IE will return a status 12000+ on some sort of connection failure,
                  //so we return a blank error
                  //http://msdn.microsoft.com/en-us/library/aa383770%28VS.85%29.aspx
                  callback(new Error());
                }
              }
            } catch (firefoxAccessException) {
              //jquery source mentions firefox may error out while accessing the
              //request members if there is a network error
              //https://github.com/jquery/jquery/blob/a938d7b1282fc0e5c52502c225ae8f0cef219f0a/src/ajax/xhr.js#L111
              if (callback) {
                callback(new Error());
              }
            }
          };

          request.open('POST', url, true);
          if (request.setRequestHeader) {
            request.setRequestHeader('Content-Type', 'application/json');
          }
          request.onreadystatechange = onreadystatechange;
          request.send(payload);
        } catch (e1) {
          // Sending using the normal xmlhttprequest object didn't work, try XDomainRequest
          if (typeof XDomainRequest !== "undefined") {
            var ontimeout = function(args) {
              if (callback) {
                callback(new Error());
              }
            };

            var onerror = function(args) {
              if (callback) {
                callback(new Error());
              }
            };

            var onload = function(args) {
              if (callback) {
                callback(null, request.responseText);
              }
            };

            request = new XDomainRequest();
            request.onprogress = function() {};
            request.ontimeout = ontimeout;
            request.onerror = onerror;
            request.onload = onload;
            request.open('POST', url, true);
            request.send(payload);
          }
        }
      } catch (e2) {
        // ignore
      }
    }
  }
};

var RollbarJSON = {
  /*
   * Derived work from json2.js at http://www.JSON.org/js.html
   */

  setupCustomStringify: function() {
    function f(n) {
      // Format integers to have at least two digits.
      return n < 10 ? '0' + n : n;
    }

    Date.prototype.toRollbarJSON = function (key) {

        return isFinite(this.valueOf()) ?
                this.getUTCFullYear()     + '-' +
                f(this.getUTCMonth() + 1) + '-' +
                f(this.getUTCDate())      + 'T' +
                f(this.getUTCHours())     + ':' +
                f(this.getUTCMinutes())   + ':' +
                f(this.getUTCSeconds())   + 'Z'
            : null;
    };

    String.prototype.toRollbarJSON      =
        Number.prototype.toRollbarJSON  =
        Boolean.prototype.toRollbarJSON = function (key) {
          return this.valueOf();
        };

    var cx = /[\u0000\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,
        escapable = /[\\\"\x00-\x1f\x7f-\x9f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,
        gap,
        indent,
        meta = {    // table of character substitutions
            '\b': '\\b',
            '\t': '\\t',
            '\n': '\\n',
            '\f': '\\f',
            '\r': '\\r',
            '"' : '\\"',
            '\\': '\\\\'
        },
        rep;


    function quote(string) {

      escapable.lastIndex = 0;
      return escapable.test(string) ? '"' + string.replace(escapable, function (a) {
        var c = meta[a];
        return typeof c === 'string' ?
          c : '\\u' + ('0000' + a.charCodeAt(0).toString(16)).slice(-4);
      }) + '"' : '"' + string + '"';
    }

    return function (value, replacer, space) {
      var seen = [];

      function str(key, holder) {

        var i,          // The loop counter.
            k,          // The member key.
            v,          // The member value.
            length,
            mind = gap,
            partial,
            value = holder[key];

        if (value && typeof value === 'object' &&
                typeof value.toRollbarJSON === 'function') {
          value = value.toRollbarJSON(key);
        }

        if (typeof rep === 'function') {
          value = rep.call(holder, key, value);
        }

        switch (typeof value) {
          case 'string':
            return quote(value);
          case 'number':
            return isFinite(value) ? String(value) : 'null';
          case 'boolean':
          case 'null':
            return String(value);
          case 'object':

            if (!value) {
                return 'null';
            }

            if (seen.indexOf(value) !== -1) {
              throw new TypeError('RollbarJSON.stringify cannot serialize cyclic structures.');
            }
            seen.push(value);

            gap += indent;
            partial = [];

            if (Object.prototype.toString.apply(value) === '[object Array]') {

              length = value.length;
              for (i = 0; i < length; i += 1) {
                  partial[i] = str(i, value) || 'null';
              }

              v = partial.length === 0 ?
                  '[]' : gap ?
                  '[\n' + gap + partial.join(',\n' + gap) + '\n' + mind + ']' :
                  '[' + partial.join(',') + ']';
              gap = mind;
              return v;
            }

            if (rep && typeof rep === 'object') {
              length = rep.length;
              for (i = 0; i < length; i += 1) {
                if (typeof rep[i] === 'string') {
                  k = rep[i];
                  v = str(k, value);
                  if (v) {
                    partial.push(quote(k) + (gap ? ': ' : ':') + v);
                  }
                }
              }
            } else {

              for (k in value) {
                if (Object.prototype.hasOwnProperty.call(value, k)) {
                  v = str(k, value);
                  if (v) {
                      partial.push(quote(k) + (gap ? ': ' : ':') + v);
                  }
                }
              }
            }

            v = partial.length === 0 ?
                '{}' : gap ?
              '{\n' + gap + partial.join(',\n' + gap) + '\n' + mind + '}'
                : '{' + partial.join(',') + '}';
            gap = mind;
            return v;
        }
      }

      var i;
      gap = '';
      indent = '';

      if (typeof space === 'number') {
        for (i = 0; i < space; i += 1) {
          indent += ' ';
        }
      } else if (typeof space === 'string') {
        indent = space;
      }

      rep = replacer;
      if (replacer && typeof replacer !== 'function' &&
              (typeof replacer !== 'object' ||
              typeof replacer.length !== 'number')) {
        throw new Error('JSON.stringify');
      }
      return str('', {'': value});
    };
  }
};

// test JSON.stringify since some old libraries don't implement it correctly
var testData = {a:[{b:1}]};
try {
  var serialized = JSON.stringify(testData);
  if (serialized !== '{"a":[{"b":1}]}') {
    RollbarJSON.stringify = RollbarJSON.setupCustomStringify();
  } else {
    RollbarJSON.stringify = JSON.stringify;
  }
} catch (e) {
  RollbarJSON.stringify = RollbarJSON.setupCustomStringify();
}

if (!window._rollbarInitialized) {
  var shim = window.Rollbar;
  var fullRollbar = new Notifier(shim);
  fullRollbar._processShimQueue(window.RollbarShimQueue || []);
  window.Rollbar = fullRollbar;
  window._rollbarInitialized = true;
}
})(window, document);