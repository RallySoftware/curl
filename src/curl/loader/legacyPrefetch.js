/** MIT License (c) copyright 2010-2013 B Cavalier & J Hann */

/**
 * curl legacy loaderPrefetch - an offshoot from the legacy loader that uses an XHR to load the 
 * resource but not parse it. This is an exact copy of the legacy loader except for the modifications
 * to the loadScript method.
 *
 * Loads legacy javascript scripts as if they were modules.  Since legacy
 * scripts don't specify any dependencies and typically hoard many
 * things into one file, this isn't always straightforward.  This loader
 * can be configured to adapt to almost any situation.
 *
 * Config options:
 *
 * exports {string}
 * Typically, specifies the name of a
 * global variable exposed by the legacy script, but can be any code that
 * can be executed by `eval()` at the global scope.  The result of the
 * `eval()` is verified not to throw an exception and is used as the value
 * exported to other modules that depend on this script.
 *
 * factory {function}
 * The factory is executed when the script
 * is loaded and should return something to export to other modules.  The
 * factory should thow an exception if it can't find the thing to export.
 * Even though the `exports` config option can evaluate arbitrary code, the
 * `factory` option should be used since it can be tested and/or linted.
 * Furthermore, the factory function takes a string argument that identifies
 * the module being requested.  This allows the function to be reused for
 * multiple modules.
 *
 * NOTE: One of the `exports` or `factory` config options must be provided
 * because, without them, there is no way for a loader to determine if a
 * script has loaded in IE6-10.
 *
 * requires {array}
 * An array of module ids that are required for the script
 * to execute correctly.  These module ids may refer to other legacy scripts
 * that have been configured via the legacy loader.
 *
 * dontWrapLegacy {boolean}
 * A build-time only option to tell cram to
 * add a define() at the end of the script rather than *around* the script.
 * Typically, this would never be needed.
 *
 * @example Backbone
 *
 * This backbone example uses a function call to return the exports.  If
 * the code to return the exports is any more sophisticated than this, you
 * should consider using a `factory` option instead of `exports` since
 * factory functions can be tested and/or linted.
 *
 * curl.config({
 *     paths: {
 *         backbone: {
 *             location: 'modules/backbone-1.3.1/backbone.js',
 *             config: {
 *                 loader: 'curl/loader/legacy',
 *                 exports: 'Backbone.noConflict()',
 *                 requires: ['jquery', 'lodash']
 *             }
 *         }
 *     }
 * });
 *
 * @example jQuery UI
 *
 * This jQuery UI example uses the `factory` option to return the correct
 * jQuery UI widget from a concatenated collection of widgets in a
 * jqueryui.js file.
 *
 * curl.config({
 *     packages: {
 *         jqueryui: {
 *             location: 'modules/jquery-1.6.3/jqueryui.js#',
 *             config: {
 *                 loader: 'curl/loader/legacy',
 *                 factory: function (fullId) {
 *                     var id = fullId.replace('jqueryui/', '');
 *                     return $.fn[id];
 *                 }
 *                 requires: ['jquery', 'css!jqueryui.css']
 *             }
 *         }
 *     }
 * });
 */
(function (global, doc, testGlobalVar) {
define(/*=='curl/loader/legacyPrefetch',==*/ ['curl/_privileged'], function (priv) {
"use strict";
	var hasAsyncFalse, loadScript, dontAddExtRx, xhr, progIds;

	progIds = ['Msxml2.XMLHTTP', 'Microsoft.XMLHTTP', 'Msxml2.XMLHTTP.4.0'];

	xhr = function () {
		if (typeof XMLHttpRequest !== "undefined") {
			// rewrite the getXhr method to always return the native implementation
			xhr = function () {
				return new XMLHttpRequest();
			};
		}
		else {
			// keep trying progIds until we find the correct one, then rewrite the getXhr method
			// to always return that one.
			var noXhr = xhr = function () {
				throw new Error("getXhr(): XMLHttpRequest not available");
			};
			while (progIds.length > 0 && xhr === noXhr) (function (id) {
				try {
					new ActiveXObject(id);
					xhr = function () {
						return new ActiveXObject(id);
					};
				}
				catch (ex) {
				}
			}(progIds.shift()));
		}
		return xhr();
	};

	hasAsyncFalse = doc && doc.createElement('script').async == true;
	loadScript = function (options, _callback, reject) {
		//this is a simple implementation that only prefetches the content and does not create any JS objects
		//useful for using spare network/CPU cycles to start loading libraries that will be needed in the future.
		var x = xhr();
		x.open('GET', options.url, true);
		x.onreadystatechange = function (e) {
			if (x.readyState === 4) {
				if (x.status < 400) {
					_callback(x.responseText);
				}
				else {
					reject(new Error('fetchText() failed. status: ' + x.statusText));
				}
			}
		};
		x.send(null);

	};//priv['core'].loadScript;
	dontAddExtRx = /\?|\.js\b/;

	return {

		'load': function (resId, require, callback, cfg) {
			var exports, factory, deps, dontAddFileExt, url, options, countdown;

			exports = cfg['exports'] || cfg.exports;
			factory = cfg['factory'] || cfg.factory;
			if (!exports && !factory) {
				throw new Error('`exports` or `factory` required for legacy: ' + resId);
			}

			deps = [].concat(cfg['requires'] || cfg.requires || []);
			dontAddFileExt = cfg['dontAddFileExt'] || cfg.dontAddFileExt;
			dontAddFileExt = dontAddFileExt
				? new RegExp(dontAddFileExt)
				: dontAddExtRx;
			url = require['toUrl'](resId);

			if (!dontAddFileExt.test(url)) {
				url = nameWithExt(url, 'js');
			}

			options = {
				url: url,
				order: true,
				// set a fake mimetype if we need to wait and don't support
				// script.async=false.
				mimetype:  hasAsyncFalse || !deps.length ? '' : 'text/cache'
			};

			// hasAsyncFalse, nodeps: load | _export
			// hasAsyncFalse, deps: getDeps+load | _export
			// !hasAsyncFalse, nodeps: load | _export
			// !hasAsyncFalse, deps: getDeps+load | reload | _export

			if (deps.length) {
				countdown = 2;
				getDeps();
				load();
			}
			else {
				countdown = 1;
				load();
			}

			function getDeps () {
				// start process of getting deps, then either export or reload
				require(deps, hasAsyncFalse ? _export : reload, reject);
			}

			function load () {
				// load script, possibly with a fake mimetype
				loadScript(options, _callback, reject);
			}

			function reload () {
				// if we faked the mimetype, we need to refetch.
				// (hopefully, from cache, if cache headers allow.)
				options.mimetype = '';
				loadScript(options, _callback, reject);
			}

			function _callback (response) {
				if (callback) {
					callback(response);
				}
			}

			function reject (ex) {
				(callback['error'] || function (ex) { throw ex; })(ex);
			}

		},

		'cramPlugin': '../cram/legacy'

	};

	function nameWithExt (name, defaultExt) {
		return name.substr(name.length - 3) !== '.' + defaultExt
			? name + '.' + defaultExt
			: name;
	}

});
}(
	this,
	this.document,
	function () { return (1, eval)(arguments[0]); }
));
