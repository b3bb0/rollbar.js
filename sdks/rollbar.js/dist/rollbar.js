(function(window, document){
function Notifier(parentNotifier) {
  this.options = {};
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

// This is the global queue where all notifiers will put their
// payloads to be sent to Rollbar.
Notifier.payloadQueue = [];

Notifier._generateLogFn = function(level) {
  return function() {
    var args = this._getLogArgs(arguments);

    return this._log(args.level || this.options.level || 'debug',
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
  console.log(args);
  var level = this.options.level || 'debug';
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
  
  return {level: level, message: message, err: err, custom: custom, callback: callback};
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

Notifier.prototype.configure = function(options) {
  // Make a copy of the options object for this notifier
  this.options = Util.copy(options);
};

/*
 * Create a new Notifier instance which has the same options
 * as the current notifier + options to override them.
 */
Notifier.prototype.scope = function(options) {
  var scopedNotifier = new Notifier(this);
  return scopedNotifier;
};
;var Util = {
  merge: function(to, from) {
    var k;
    for (k in from) {
      if (from[k].constructor == Object) {
        if (!to.hasOwnProperty(k)) {
          to[k] = from[k];
        } else {
          to[k] = merge(to[k], from[k]);
        }
      } else {
        to[k] = from[k];
      }
    }
    return to;
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
    if (url) {
      var baseUrlParts = Util.parseUri(url);
      // remove a trailing # if there is no anchor
      if (baseUrlParts.anchor === '') {
        baseUrlParts.source = baseUrlParts.source.replace('#', '');
      }
      var baseUrl = baseUrlParts.source.replace('?' + baseUrlParts.query, ''); 
      url = baseUrl;
    }
    return url;
  }
};
;if (!window._rollbarInitialized) {
  var shim = window.Rollbar;
  var fullRollbar = new Notifier(shim);
  fullRollbar._processShimQueue(window.RollbarShimQueue || []);
  window.Rollbar = fullRollbar;
  window._rollbarInitialized = true;
}
})(window, document);