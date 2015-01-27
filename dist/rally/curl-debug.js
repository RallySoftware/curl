/* version: 0.8.11 */
/** @license MIT License (c) copyright 2010-2013 B Cavalier & J Hann */

/**
 * curl (cujo resource loader)
 * An AMD-compliant javascript module and resource loader
 *
 * curl is part of the cujo.js family of libraries (http://cujojs.com/)
 *
 * Licensed under the MIT License at:
 * 		http://www.opensource.org/licenses/mit-license.php
 *
 */
(function (global) {
//"use strict"; don't restore this until the config routine is refactored
	var
		version = '0.8.11',
		curlName = 'curl',
		defineName = 'define',
		bootScriptAttr = 'data-curl-run',
		bootScript,
		userCfg,
		prevCurl,
		prevDefine,
		doc = global.document,
		head = doc && (doc['head'] || doc.getElementsByTagName('head')[0]),
		// to keep IE from crying, we need to put scripts before any
		// <base> elements, but after any <meta>. this should do it:
		insertBeforeEl = head && head.getElementsByTagName('base')[0] || null,
		// constants / flags
		msgUsingExports = {},
		msgFactoryExecuted = {},
		// this is the list of scripts that IE is loading. one of these will
		// be the "interactive" script. too bad IE doesn't send a readystatechange
		// event to tell us exactly which one.
		activeScripts = {},
		// readyStates for IE6-9
		readyStates = 'addEventListener' in global ? {} : { 'loaded': 1, 'complete': 1 },
		// these are always handy :)
		cleanPrototype = {},
		toString = cleanPrototype.toString,
		undef,
		// local cache of resource definitions (lightweight promises)
		cache = {},
		// local url cache
		urlCache = {},
		// preload are files that must be loaded before any others
		preload = false,
		// net to catch anonymous define calls' arguments (non-IE browsers)
		argsNet,
		// RegExp's used later, pre-compiled here
		dontAddExtRx = /\?|\.js\b/,
		absUrlRx = /^\/|^[^:]+:\/\/|^[A-Za-z]:[\\/]/,
		findDotsRx = /(\.)(\.?)(?:$|\/([^\.\/]+.*)?)/g,
		removeCommentsRx = /\/\*[\s\S]*?\*\/|\/\/.*?[\n\r]/g,
		findRValueRequiresRx = /require\s*\(\s*(["'])(.*?[^\\])\1\s*\)|[^\\]?(["'])/g,
		splitCommaSepRx = /\s*,\s*/,
		cjsGetters,
		core;

	function noop () {}

	function isType (obj, type) {
		return toString.call(obj).indexOf('[object ' + type) == 0;
	}

	function normalizePkgDescriptor (descriptor, isPkg) {
		var main;

		descriptor.path = removeEndSlash(descriptor['path'] || descriptor['location'] || '');
		if (isPkg) {
			main = descriptor['main'] || './main';
			if (!isRelUrl(main)) main = './' + main;
			// trailing slashes trick reduceLeadingDots to see them as base ids
			descriptor.main = reduceLeadingDots(main, descriptor.name + '/');
		}
		descriptor.config = descriptor['config'];

		return descriptor;
	}

	function isRelUrl (it) {
		return it.charAt(0) == '.';
	}

	function isAbsUrl (it) {
		return absUrlRx.test(it);
	}

	function joinPath (path, file) {
		return removeEndSlash(path) + '/' + file;
	}

	function removeEndSlash (path) {
		return path && path.charAt(path.length - 1) == '/' ? path.substr(0, path.length - 1) : path;
	}

	function reduceLeadingDots (childId, baseId) {
		// this algorithm is similar to dojo's compactPath, which interprets
		// module ids of "." and ".." as meaning "grab the module whose name is
		// the same as my folder or parent folder".  These special module ids
		// are not included in the AMD spec but seem to work in node.js, too.
		var removeLevels, normId, levels, isRelative, diff;

		removeLevels = 1;
		normId = childId;

		// remove leading dots and count levels
		if (isRelUrl(normId)) {
			isRelative = true;
			normId = normId.replace(findDotsRx, function (m, dot, doubleDot, remainder) {
				if (doubleDot) removeLevels++;
				return remainder || '';
			});
		}

		if (isRelative) {
			levels = baseId.split('/');
			diff = levels.length - removeLevels;
			if (diff < 0) {
				// this is an attempt to navigate above parent module.
				// maybe dev wants a url or something. punt and return url;
				return childId;
			}
			levels.splice(diff, removeLevels);
			// normId || [] prevents concat from adding extra "/" when
			// normId is reduced to a blank string
			return levels.concat(normId || []).join('/');
		}
		else {
			return normId;
		}
	}

	function pluginParts (id) {
		var delPos = id.indexOf('!');
		return {
			resourceId: id.substr(delPos + 1),
			// resourceId can be zero length
			pluginId: delPos >= 0 && id.substr(0, delPos)
		};
	}

	function Begetter () {}

	function beget (parent, mixin) {
		Begetter.prototype = parent || cleanPrototype;
		var child = new Begetter();
		Begetter.prototype = cleanPrototype;
		for (var p in mixin) child[p] = mixin[p];
		return child;
	}

	function Promise () {

		var self, thens, complete;

		self = this;
		thens = [];

		function then (resolved, rejected, progressed) {
			// capture calls to callbacks
			thens.push([resolved, rejected, progressed]);
		}

		function notify (which, arg) {
			// complete all callbacks
			var aThen, cb, i = 0;
			while ((aThen = thens[i++])) {
				cb = aThen[which];
				if (cb) cb(arg);
			}
		}

		complete = function promiseComplete (success, arg) {
			// switch over to sync then()
			then = success ?
				function (resolved, rejected) { resolved && resolved(arg); } :
				function (resolved, rejected) { rejected && rejected(arg); };
			// we no longer throw during multiple calls to resolve or reject
			// since we don't really provide useful information anyways.
			complete = noop;
			// complete all callbacks
			notify(success ? 0 : 1, arg);
			// no more notifications
			notify = noop;
			// release memory
			thens = undef;
		};

		this.then = function (resolved, rejected, progressed) {
			then(resolved, rejected, progressed);
			return self;
		};
		this.resolve = function (val) {
			self.resolved = val;
			complete(true, val);
		};
		this.reject = function (ex) {
			self.rejected = ex;
			complete(false, ex);
		};
		this.progress = function (msg) {
			notify(2, msg);
		}

	}

	function isPromise (o) {
		return o instanceof Promise || o instanceof CurlApi;
	}

	function when (promiseOrValue, callback, errback, progback) {
		// we can't just sniff for then(). if we do, resources that have a
		// then() method will make dependencies wait!
		if (isPromise(promiseOrValue)) {
			return promiseOrValue.then(callback, errback, progback);
		}
		else {
			return callback(promiseOrValue);
		}
	}

	/**
	 * Returns a function that when executed, executes a lambda function,
	 * but only executes it the number of times stated by howMany.
	 * When done executing, it executes the completed function. Each callback
	 * function receives the same parameters that are supplied to the
	 * returned function each time it executes.  In other words, they
	 * are passed through.
	 * @private
	 * @param howMany {Number} must be greater than zero
	 * @param lambda {Function} executed each time
	 * @param completed {Function} only executes once when the counter
	 *   reaches zero
	 * @returns {Function}
	 */
	function countdown (howMany, lambda, completed) {
		var result;
		return function () {
			if (--howMany >= 0 && lambda) result = lambda.apply(undef, arguments);
			// we want ==, not <=, since some callers expect call-once functionality
			if (howMany == 0 && completed) completed(result);
			return result;
		}
	}

	core = {

		/**
		 * * reduceLeadingDots of id against parentId
		 *		- if there are too many dots (path goes beyond parent), it's a url
		 *			- return reduceLeadingDots of id against baseUrl + parentId;
		 *	* if id is a url (starts with dots or slash or protocol)
		 *		- pathInfo = { config: userCfg, url: url }
		 *	* if not a url, id-to-id transform here.
		 *		- main module expansion
		 *		- plugin prefix expansion
		 *		- coordinate main module expansion with plugin expansion
		 *			- main module expansion happens first
		 *		- future: other transforms?
		 * @param id
		 * @param parentId
		 * @param cfg
		 * @return {*}
		 */
		toAbsId: function (id, parentId, cfg) {
			var absId, pluginId, parts;

			absId = reduceLeadingDots(id, parentId);

			// if this is still a relative path, it must be a url
			// so just punt, otherwise...
			if (isRelUrl(absId)) return absId;

			// plugin id split
			parts = pluginParts(absId);
			pluginId = parts.pluginId;
			absId = pluginId || parts.resourceId;

			// main id expansion
			if (absId in cfg.pathMap) {
				absId = cfg.pathMap[absId].main || absId;
			}

			// plugin id expansion
			if (pluginId) {
				if (pluginId.indexOf('/') < 0 && !(pluginId in cfg.pathMap)) {
					absId = joinPath(cfg.pluginPath, pluginId);
				}
				absId = absId + '!' + parts.resourceId;
			}

			return absId;
		},

		createContext: function (cfg, baseId, depNames, isPreload) {

			var def;

			def = new Promise();
			def.id = baseId || ''; // '' == global
			def.isPreload = isPreload;
			def.depNames = depNames;
			def.config = cfg;

			// functions that dependencies will use:

			function toAbsId (childId, checkPlugins) {
				var absId, parts, plugin;

				absId = core.toAbsId(childId, def.id, cfg);
				if (!checkPlugins) return absId;

				parts = pluginParts(absId);
				if (!parts.pluginId) return absId;

				plugin = cache[parts.pluginId];
				// check if plugin supports the normalize method
				if ('normalize' in plugin) {
					// note: dojo/has may return falsey values (0, actually)
					parts.resourceId = plugin['normalize'](parts.resourceId, toAbsId, def.config) || '';
				}
				else {
					parts.resourceId = toAbsId(parts.resourceId);
				}
				return parts.pluginId + '!' + parts.resourceId;
			}

			function toUrl (n) {
				// the AMD spec states that we should not append an extension
				// in this function since it could already be appended.
				// we need to use toAbsId in case this is a module id.
				return core.resolvePathInfo(toAbsId(n, true), cfg).url;
			}

			function localRequire (ids, callback, errback) {
				var cb, rvid, childDef, earlyExport;

				// this is public, so send pure function
				// also fixes issue #41
				cb = callback && function () { callback.apply(undef, arguments[0]); };

				// RValue require (CommonJS)
				if (isType(ids, 'String')) {
					if (cb) {
						throw new Error('require(id, callback) not allowed');
					}
					// return resource
					rvid = toAbsId(ids, true);
					childDef = cache[rvid];
					if (!(rvid in cache)) {
						// this should only happen when devs attempt their own
						// manual wrapping of cjs modules or get confused with
						// the callback syntax:
						throw new Error('Module not resolved: '  + rvid);
					}
					earlyExport = isPromise(childDef) && childDef.exports;
					return earlyExport || childDef;
				}
				else {
					when(core.getDeps(core.createContext(cfg, def.id, ids, isPreload)), cb, errback);
				}
			}

			def.require = localRequire;
			localRequire['toUrl'] = toUrl;
			def.toAbsId = toAbsId;

			return def;
		},

		createResourceDef: function (cfg, id, isPreload) {
			var def, origResolve, execute;

			def = core.createContext(cfg, id, undef, isPreload);
			origResolve = def.resolve;

			// using countdown to only execute definition function once
			execute = countdown(1, function (deps) {
				def.deps = deps;
				try {
					return core.executeDefFunc(def);
				}
				catch (ex) {
					def.reject(ex);
				}
			});

			// intercept resolve function to execute definition function
			// before resolving
			def.resolve = function resolve (deps) {
				when(isPreload || preload, function () {
					origResolve((cache[def.id] = urlCache[def.url] = execute(deps)));
				});
			};

			// track exports
			def.exportsReady = function executeFactory (deps) {
				when(isPreload || preload, function () {
					// only resolve early if we also use exports (to avoid
					// circular dependencies). def.exports will have already
					// been set by the getDeps loop before we get here.
					if (def.exports) {
						execute(deps);
						def.progress(msgFactoryExecuted);
					}
				});
			};

			return def;
		},

		createPluginDef: function (cfg, id, resId, isPreload) {
			var def;

			// use resource id for local require and toAbsId
			def = core.createContext(cfg, resId, undef, isPreload);

			return def;
		},

		getCjsRequire: function (def) {
			return def.require;
		},

		getCjsExports: function (def) {
			return def.exports || (def.exports = {});
		},

		getCjsModule: function (def) {
			var module = def.module;
			if (!module) {
				module = def.module = {
					'id': def.id,
					'uri': core.getDefUrl(def),
					'exports': core.getCjsExports(def),
					'config': function () { return def.config; }
				};
				module.exports = module['exports']; // oh closure compiler!
			}
			return module;
		},

		getDefUrl: function (def) {
			// note: this is used by cjs module.uri
			return def.url || (def.url = core.checkToAddJsExt(def.require['toUrl'](def.id), def.config));
		},

		/**
		 * Sets the curl() and define() APIs.
		 * @param [cfg] {Object|Null} set of config params. If missing or null,
		 *   this function will set the default API!
		 */
		setApi: function (cfg) {
			/*
			scenarios:
			1. global config sets apiName: "require"
				- first call to config sets api
				- second and later calls are ignored
				- prevCurl cannot exist
			2. no global config, first call to config() sets api
				- first call to config has no api info
				- second call to config sets api
				- third and later calls must be ignored
			3. global config that doesn't set api, first call does though
				- same as #2
			4. api info is never set
				- how to know when to stop ignoring?

			objectives:
			1. fail before mistakenly overwriting global[curlName]
			2. allow rename/relocate of curl() and define()
			3. restore curl() if we overwrote it
			 */

			var apiName, defName, apiObj, defObj,
				failMsg, okToOverwrite;

			apiName = curlName;
			defName = defineName;
			apiObj = defObj = global;
			failMsg = ' already exists';

			// if we're not setting defaults
			if (cfg) {
				// is it ok to overwrite existing api functions?
				okToOverwrite = cfg['overwriteApi'] || cfg.overwriteApi;
				// allow dev to rename/relocate curl() to another object
				apiName = cfg['apiName'] || cfg.apiName || apiName;
				apiObj = cfg['apiContext'] || cfg.apiContext || apiObj;
				// define() too
				defName = cfg['defineName'] || cfg.defineName || defName;
				defObj = cfg['defineContext'] || cfg.defineContext || defObj;

				// curl() already existed, restore it if this is not a
				// setDefaults pass. dev must be a good citizen and set
				// apiName/apiContext (see below).
				if (prevCurl && isType(prevCurl, 'Function')) {
					// restore previous curl()
					global[curlName] = prevCurl;
				}
				prevCurl = null; // don't check ever again
				// ditto for define()
				if (prevDefine && isType(prevDefine, 'Function')) {
					// restore previous curl()
					global[defineName] = prevDefine;
				}
				prevDefine = null; // don't check ever again

				// check if we're mistakenly overwriting either api
				// if we're configuring, and there's a curl(), and it's not
				// ours -- and we're not explicitly overwriting -- throw!
				// Note: if we're setting defaults, we *must* overwrite curl
				// so that dev can configure it.  This is no different than
				// noConflict()-type methods.
				if (!okToOverwrite) {
					if (apiObj[apiName] && apiObj[apiName] != _curl) {
						throw new Error(apiName + failMsg);
					}
					// check if we're overwriting amd api
					if (defObj[defName] && defObj[defName] != define) {
						throw new Error(defName + failMsg);
					}
				}

			}

			// set curl api
			apiObj[apiName] = _curl;

			// set AMD public api: define()
			defObj[defName] = define;

		},

		config: function (cfg) {
			var prevCfg, newCfg, pluginCfgs, p;

			// convert from closure-safe names
			if ('baseUrl' in cfg) cfg.baseUrl = cfg['baseUrl'];
			if ('main' in cfg) cfg.main = cfg['main'];
			if ('preloads' in cfg) cfg.preloads = cfg['preloads'];
			if ('pluginPath' in cfg) cfg.pluginPath = cfg['pluginPath'];
			if ('dontAddFileExt' in cfg || cfg.dontAddFileExt) {
				cfg.dontAddFileExt = new RegExp(cfg['dontAddFileExt'] || cfg.dontAddFileExt);
			}

			prevCfg = userCfg;
			newCfg = beget(prevCfg, cfg);

			// create object to hold path map.
			// each plugin and package will have its own pathMap, too.
			newCfg.pathMap = beget(prevCfg.pathMap);
			pluginCfgs = cfg['plugins'] || {};
			newCfg.plugins = beget(prevCfg.plugins);
			newCfg.paths = beget(prevCfg.paths, cfg.paths);
			newCfg.packages = beget(prevCfg.packages, cfg.packages);

			// temporary arrays of paths. this will be converted to
			// a regexp for fast path parsing.
			newCfg.pathList = [];

			// normalizes path/package info and places info on either
			// the global cfg.pathMap or on a plugin-specific altCfg.pathMap.
			// also populates a pathList on cfg or plugin configs.
			function fixAndPushPaths (coll, isPkg) {
				var id, pluginId, data, parts, currCfg, info;
				for (var name in coll) {
					data = coll[name];
					if (isType(data, 'String')) data = {
						path: coll[name]
					};
					// grab the package id, if specified. default to
					// property name, if missing.
					data.name = data.name || name;
					currCfg = newCfg;
					// check if this is a plugin-specific path
					parts = pluginParts(removeEndSlash(data.name));
					id = parts.resourceId;
					pluginId = parts.pluginId;
					if (pluginId) {
						// plugin-specific path
						currCfg = pluginCfgs[pluginId];
						if (!currCfg) {
							currCfg = pluginCfgs[pluginId] = beget(newCfg);
							currCfg.pathMap = beget(newCfg.pathMap);
							currCfg.pathList = [];
						}
						// remove plugin-specific path from coll
						delete coll[name];
					}
					info = normalizePkgDescriptor(data, isPkg);
					if (info.config) info.config = beget(newCfg, info.config);
					info.specificity = id.split('/').length;
					if (id) {
						currCfg.pathMap[id] = info;
						currCfg.pathList.push(id);
					}
					else {
						// naked plugin name signifies baseUrl for plugin
						// resources. baseUrl could be relative to global
						// baseUrl.
						currCfg.baseUrl = core.resolveUrl(data.path, newCfg);
					}
				}
			}

			// adds the path matching regexp onto the cfg or plugin cfgs.
			function convertPathMatcher (cfg) {
				var pathMap = cfg.pathMap;
				cfg.pathRx = new RegExp('^(' +
					cfg.pathList.sort(function (a, b) { return pathMap[b].specificity - pathMap[a].specificity; } )
						.join('|')
						.replace(/\/|\./g, '\\$&') +
					')(?=\\/|$)'
				);
				delete cfg.pathList;
			}

			// fix all new packages, then paths (in case there are
			// plugin-specific paths for a main module, such as wire!)
			fixAndPushPaths(cfg['packages'], true);
			fixAndPushPaths(cfg['paths'], false);

			// process plugins after packages in case we already perform an
			// id transform on a plugin (i.e. it's a package.main)
			for (p in pluginCfgs) {
				var absId = core.toAbsId(p + '!', '', newCfg);
				newCfg.plugins[absId.substr(0, absId.length - 1)] = pluginCfgs[p];
			}
			pluginCfgs = newCfg.plugins;

			// create search regex for each path map
			for (p in pluginCfgs) {
				// inherit full config
				pluginCfgs[p] = beget(newCfg, pluginCfgs[p]);
				var pathList = pluginCfgs[p].pathList;
				if (pathList) {
					pluginCfgs[p].pathList = pathList.concat(newCfg.pathList);
					convertPathMatcher(pluginCfgs[p]);
				}
			}

			// ugh, this is ugly, but necessary until we refactor this function
			// copy previous pathMap items onto pathList
			for (p in prevCfg.pathMap) {
				if (!newCfg.pathMap.hasOwnProperty(p)) newCfg.pathList.push(p);
			}

			convertPathMatcher(newCfg);

			return newCfg;

		},

		resolvePathInfo: function (absId, cfg) {
			// searches through the configured path mappings and packages
			var pathMap, pathInfo, path, pkgCfg;

			pathMap = cfg.pathMap;

			if (!isAbsUrl(absId)) {
				path = absId.replace(cfg.pathRx, function (match) {
					// TODO: remove fallbacks here since they should never need to happen
					pathInfo = pathMap[match] || {};
					pkgCfg = pathInfo.config;
					return pathInfo.path || '';
				});
			}
			else {
				path = absId;
			}

			return {
				config: pkgCfg || userCfg,
				url: core.resolveUrl(path, cfg)
			};
		},

		resolveUrl: function (path, cfg) {
			var baseUrl = cfg.baseUrl;
			return baseUrl && !isAbsUrl(path) ? joinPath(baseUrl, path) : path;
		},

		checkToAddJsExt: function (url, cfg) {
			// don't add extension if a ? is found in the url (query params)
			// i'd like to move this feature to a moduleLoader
			return url + ((cfg || userCfg).dontAddFileExt.test(url) ? '' : '.js');
		},

		loadScript: function (def, success, failure) {
			// script processing rules learned from RequireJS
			// TODO: pass a validate function into loadScript to check if a success really is a success

			// insert script
			var el = doc.createElement('script');

			// initial script processing
			function process (ev) {
				ev = ev || global.event;
				// detect when it's done loading
				// ev.type == 'load' is for all browsers except IE6-9
				// IE6-9 need to use onreadystatechange and look for
				// el.readyState in {loaded, complete} (yes, we need both)
				if (ev.type == 'load' || readyStates[el.readyState]) {
					delete activeScripts[def.id];
					// release event listeners
					el.onload = el.onreadystatechange = el.onerror = ''; // ie cries if we use undefined
					success();
				}
			}

			function fail (e) {
				// some browsers send an event, others send a string,
				// but none of them send anything useful, so just say we failed:
				failure(new Error('Syntax or http error: ' + def.url));
			}

			// set type first since setting other properties could
			// prevent us from setting this later
			// actually, we don't even need to set this at all
			//el.type = 'text/javascript';
			// using dom0 event handlers instead of wordy w3c/ms
			el.onload = el.onreadystatechange = process;
			el.onerror = fail;
			// js! plugin uses alternate mimetypes
			el.type = def.mimetype || 'text/javascript';
			// TODO: support other charsets?
			el.charset = 'utf-8';
			el.async = !def.order;
			el.src = def.url;

			// loading will start when the script is inserted into the dom.
			// IE will load the script sync if it's in the cache, so
			// indicate the current resource definition if this happens.
			activeScripts[def.id] = el;

			head.insertBefore(el, insertBeforeEl);

			// the js! plugin uses this
			return el;
		},

		extractCjsDeps: function (defFunc) {
			// Note: ignores require() inside strings and comments
			var source, ids = [], currQuote;
			// prefer toSource (FF) since it strips comments
			source = typeof defFunc == 'string' ?
					 defFunc :
					 defFunc.toSource ? defFunc.toSource() : defFunc.toString();
			// remove comments, then look for require() or quotes
			source.replace(removeCommentsRx, '').replace(findRValueRequiresRx, function (m, rq, id, qq) {
				// if we encounter a string in the source, don't look for require()
				if (qq) {
					currQuote = currQuote == qq ? undef : currQuote;
				}
				// if we're not inside a quoted string
				else if (!currQuote) {
					ids.push(id);
				}
				return ''; // uses least RAM/CPU
			});
			return ids;
		},

		fixArgs: function (args) {
			// resolve args
			// valid combinations for define:
			// (string, array, object|function) sax|saf
			// (array, object|function) ax|af
			// (string, object|function) sx|sf
			// (object|function) x|f

			var id, deps, defFunc, defFuncArity, len, cjs;

			len = args.length;

			defFunc = args[len - 1];
			defFuncArity = isType(defFunc, 'Function') ? defFunc.length : -1;

			if (len == 2) {
				if (isType(args[0], 'Array')) {
					deps = args[0];
				}
				else {
					id = args[0];
				}
			}
			else if (len == 3) {
				id = args[0];
				deps = args[1];
			}

			// Hybrid format: assume that a definition function with zero
			// dependencies and non-zero arity is a wrapped CommonJS module
			if (!deps && defFuncArity > 0) {
				cjs = true;
				deps = ['require', 'exports', 'module'].slice(0, defFuncArity).concat(core.extractCjsDeps(defFunc));
			}

			return {
				id: id,
				deps: deps || [],
				res: defFuncArity >= 0 ? defFunc : function () { return defFunc; },
				cjs: cjs
			};
		},

		executeDefFunc: function (def) {
			var resource, moduleThis;
			// the force of AMD is strong so anything returned
			// overrides exports.
			// node.js assumes `this` === `exports` so we do that
			// for all cjs-wrapped modules, just in case.
			// also, use module.exports if that was set
			// (node.js convention).
			// note: if .module exists, .exports exists.
			moduleThis = def.cjs ? def.exports : undef;
			resource = def.res.apply(moduleThis, def.deps);
			if (resource === undef && def.exports) {
				// note: exports will equal module.exports unless
				// module.exports was reassigned inside module.
				resource = def.module
					? (def.exports = def.module['exports'])
					: def.exports;
			}
			return resource;
		},

		defineResource: function (def, args) {

			def.res = args.res;
			def.cjs = args.cjs;
			def.depNames = args.deps;
			core.getDeps(def);

		},

		getDeps: function (parentDef) {

			var i, names, deps, len, dep, completed, name,
				exportCollector, resolveCollector;

			deps = [];
			names = parentDef.depNames;
			len = names.length;

			if (names.length == 0) allResolved();

			function collect (dep, index, alsoExport) {
				deps[index] = dep;
				if (alsoExport) exportCollector(dep, index);
			}

			// reducer-collectors
			exportCollector = countdown(len, collect, allExportsReady);
			resolveCollector = countdown(len, collect, allResolved);

			// initiate the resolution of all dependencies
			// Note: the correct handling of early exports relies on the
			// fact that the exports pseudo-dependency is always listed
			// before other module dependencies.
			for (i = 0; i < len; i++) {
				name = names[i];
				// is this "require", "exports", or "module"?
				if (name in cjsGetters) {
					// a side-effect of cjsGetters is that the cjs
					// property is also set on the def.
					resolveCollector(cjsGetters[name](parentDef), i, true);
					// if we are using the `module` or `exports` cjs variables,
					// signal any waiters/parents that we can export
					// early (see progress callback in getDep below).
					// note: this may fire for `require` as well, if it
					// is listed after `module` or `exports` in the deps list,
					// but that is okay since all waiters will only record
					// it once.
					if (parentDef.exports) {
						parentDef.progress(msgUsingExports);
					}
				}
				// check for blanks. fixes #32.
				// this helps support yepnope.js, has.js, and the has! plugin
				else if (!name) {
					resolveCollector(undef, i, true);
				}
				// normal module or plugin resource
				else {
					getDep(name, i);
				}
			}

			return parentDef;

			function getDep (name, index) {
				var resolveOnce, exportOnce, childDef, earlyExport;

				resolveOnce = countdown(1, function (dep) {
					exportOnce(dep);
					resolveCollector(dep, index);
				});
				exportOnce = countdown(1, function (dep) {
					exportCollector(dep, index);
				});

				// get child def / dep
				childDef = core.fetchDep(name, parentDef);

				// check if childDef can export. if it can, then
				// we missed the notification and it will never fire in the
				// when() below.
				earlyExport = isPromise(childDef) && childDef.exports;
				if (earlyExport) {
					exportOnce(earlyExport);
				}

				when(childDef,
					resolveOnce,
					parentDef.reject,
					parentDef.exports && function (msg) {
						// messages are only sent from childDefs that support
						// exports, and we only notify parents that understand
						// exports too.
						if (childDef.exports) {
							if (msg == msgUsingExports) {
								// if we're using exports cjs variable on both sides
								exportOnce(childDef.exports);
							}
							else if (msg == msgFactoryExecuted) {
								resolveOnce(childDef.exports);
							}
						}
					}
				);
			}

			function allResolved () {
				parentDef.resolve(deps);
			}

			function allExportsReady () {
				parentDef.exportsReady && parentDef.exportsReady(deps);
			}

		},

		fetchResDef: function (def) {

			// ensure url is computed
			core.getDefUrl(def);

			core.loadScript(def,

				function () {
					var args = argsNet;
					argsNet = undef; // reset it before we get deps

					// if our resource was not explicitly defined with an id (anonymous)
					// Note: if it did have an id, it will be resolved in the define()
					if (def.useNet !== false) {

						// if !args, nothing was added to the argsNet
						if (!args || args.ex) {
							def.reject(new Error(((args && args.ex) || 'define() missing or duplicated: ' + def.url)));
						}
						else {
							core.defineResource(def, args);
						}
					}

				},

				def.reject

			);

			return def;

		},

		fetchDep: function (depName, parentDef) {
			var toAbsId, isPreload, parentCfg, parts, absId, mainId, loaderId, pluginId,
				resId, pathInfo, def, tempDef, resCfg;

			toAbsId = parentDef.toAbsId;
			isPreload = parentDef.isPreload;
			parentCfg = parentDef.config || userCfg; // is this fallback necessary?

			absId = toAbsId(depName);

			if (absId in cache) {
				// module already exists in cache
				mainId = absId;
			}
			else {
				// check for plugin loaderId
				parts = pluginParts(absId);
				resId = parts.resourceId;
				// get id of first resource to load (which could be a plugin)
				mainId = parts.pluginId || resId;
				pathInfo = core.resolvePathInfo(mainId, parentCfg);
			}

			if (!(absId in cache)) {
				resCfg = core.resolvePathInfo(resId, parentCfg).config;
				if (parts.pluginId) {
					loaderId = mainId;
				}
				else {
					// get custom module loader from package config if not a plugin
					// TODO: move config.moduleLoader to config.loader
					loaderId = resCfg['moduleLoader'] || resCfg.moduleLoader
						|| resCfg['loader'] || resCfg.loader;
					if (loaderId) {
						// TODO: allow transforms to have relative module ids?
						// (we could do this by returning package location from
						// resolvePathInfo. why not return all package info?)
						resId = mainId;
						mainId = loaderId;
						pathInfo = core.resolvePathInfo(loaderId, parentCfg);
					}
				}
			}

			if (mainId in cache) {
				def = cache[mainId];
			}
			else if (pathInfo.url in urlCache) {
				def = cache[mainId] = urlCache[pathInfo.url];
			}
			else {
				def = core.createResourceDef(resCfg, mainId, isPreload);
				// TODO: can this go inside createResourceDef?
				// TODO: can we pass pathInfo.url to createResourceDef instead?
				def.url = core.checkToAddJsExt(pathInfo.url, pathInfo.config);
				cache[mainId] = urlCache[pathInfo.url] = def;
				core.fetchResDef(def);
			}

			// plugin or transformer
			if (mainId == loaderId) {

				// use plugin's config if specified
				if (parts.pluginId && parentCfg.plugins[parts.pluginId]) {
					resCfg = parentCfg.plugins[parts.pluginId];
				}
				// we need to use an anonymous promise until plugin tells
				// us normalized id. then, we need to consolidate the promises
				// below. Note: exports objects will be different between
				// pre-normalized and post-normalized defs! does this matter?
				// don't put this resource def in the cache because if the
				// resId doesn't change, the check if this is a new
				// normalizedDef (below) will think it's already being loaded.
				tempDef = new Promise();

				// wait for plugin resource def
				when(def, function(plugin) {
					var normalizedDef, fullId, dynamic;

					dynamic = plugin['dynamic'];
					// check if plugin supports the normalize method
					if ('normalize' in plugin) {
						// note: dojo/has may return falsey values (0, actually)
						resId = plugin['normalize'](resId, toAbsId, def.config) || '';
					}
					else {
						resId = toAbsId(resId);
					}

					// use the full id (loaderId + id) to id plugin resources
					// so multiple plugins may each process the same resource
					// resId could be blank if the plugin doesn't require any (e.g. "domReady!")
					fullId = loaderId + '!' + resId;
					normalizedDef = cache[fullId];

					// if this is our first time fetching this (normalized) def
					if (!(fullId in cache)) {

						// because we're using resId, plugins, such as wire!,
						// can use paths relative to the resource
						normalizedDef = core.createPluginDef(resCfg, fullId, resId, isPreload);

						// don't cache non-determinate "dynamic" resources
						if (!dynamic) {
							cache[fullId] = normalizedDef;
						}

						// curl's plugins prefer to receive a deferred,
						// but to be compatible with AMD spec, we have to
						// piggy-back on the callback function parameter:
						var loaded = function (res) {
							if (!dynamic) cache[fullId] = res;
							normalizedDef.resolve(res);
						};
						loaded['resolve'] = loaded;
						loaded['reject'] = loaded['error'] = normalizedDef.reject;

						// load the resource!
						plugin.load(resId, normalizedDef.require, loaded, resCfg);

					}

					// chain defs (resolve when plugin.load executes)
					if (tempDef != normalizedDef) {
						when(normalizedDef, tempDef.resolve, tempDef.reject, tempDef.progress);
					}

				}, tempDef.reject);

			}

			// return tempDef if this is a plugin-based resource
			return tempDef || def;
		},

		getCurrentDefName: function () {
			// IE6-9 mark the currently executing thread as "interactive"
			// Note: Opera lies about which scripts are "interactive", so we
			// just have to test for it. Opera provides a true browser test, not
			// a UA sniff, thankfully.
			// learned this trick from James Burke's RequireJS
			var def;
			if (!isType(global.opera, 'Opera')) {
				for (var d in activeScripts) {
					if (activeScripts[d].readyState == 'interactive') {
						def = d;
						break;
					}
				}
			}
			return def;
		},

		findScript: function (predicate) {
			var i = 0, scripts, script;
			scripts = doc && (doc.scripts || doc.getElementsByTagName('script'));
			while (scripts && (script = scripts[i++])) {
				if (predicate(script)) return script;
			}
		},

		extractDataAttrConfig: function () {
			var script, attr = '';
			script = core.findScript(function (script) {
				var run;
				// find data-curl-run attr on script element
				run = script.getAttribute(bootScriptAttr);
				if (run) attr = run;
				return run;
			});
			// removeAttribute is wonky (in IE6?) but this works
			if (script) {
				script.setAttribute(bootScriptAttr, '');
			}
			return attr;
		},

		bootScript: function () {
			var urls = bootScript.split(splitCommaSepRx);
			if (urls.length) {
				load();
			}
			function load () {
				// Note: IE calls success handler if it gets a 400+.
				core.loadScript({ url: urls.shift() }, check, check);
			}
			function check () {
				// check if run.js called curl() or curl.config()
				if (bootScript) {
					if (urls.length) {
						// show an error message
						core.nextTurn(fail);
						// try next
						load();
					}
					else fail('run.js script did not run.');
				}
			}
			function fail (msg) {
				throw new Error(msg || 'Primary run.js failed. Trying fallback.');
			}
		},

		nextTurn: function (task) {
			setTimeout(task, 0);
		}

	};

	// hook-up cjs free variable getters
	cjsGetters = {'require': core.getCjsRequire, 'exports': core.getCjsExports, 'module': core.getCjsModule};

	function _curl (/* various */) {
		var args, promise, cfg;

		// indicate we're no longer waiting for a boot script
		bootScript = '';

		args = [].slice.call(arguments);

		// extract config, if it's specified
		if (isType(args[0], 'Object')) {
			cfg = args.shift();
			promise = _config(cfg);
		}

		return new CurlApi(args[0], args[1], args[2], promise);
	}

	function _config (cfg, callback, errback) {
		var pPromise, main, fallback;

		// indicate we're no longer waiting for a boot script
		bootScript = '';

		if (cfg) {
			core.setApi(cfg);
			userCfg = core.config(cfg);
			// check for preloads
			if ('preloads' in cfg) {
				pPromise = new CurlApi(cfg['preloads'], undef, errback, preload, true);
				// yes, this is hacky and embarrassing. now that we've got that
				// settled... until curl has deferred factory execution, this
				// is the only way to stop preloads from dead-locking when
				// they have dependencies inside a bundle.
				core.nextTurn(function () { preload = pPromise; });
			}
			// check for main module(s). all modules wait for preloads implicitly.
			main = cfg['main'];
			if (main) {
				return new CurlApi(main, callback, errback);
			}
		}
	}

	// thanks to Joop Ringelberg for helping troubleshoot the API
	function CurlApi (ids, callback, errback, waitFor, isPreload) {
		var then, ctx;

		ctx = core.createContext(userCfg, undef, [].concat(ids), isPreload);

		this['then'] = this.then = then = function (resolved, rejected) {
			when(ctx,
				// return the dependencies as arguments, not an array
				function (deps) {
					if (resolved) resolved.apply(undef, deps);
				},
				// just throw if the dev didn't specify an error handler
				function (ex) {
					if (rejected) rejected(ex); else throw ex;
				}
			);
			return this;
		};

		this['next'] = function (ids, cb, eb) {
			// chain api
			return new CurlApi(ids, cb, eb, ctx);
		};

		this['config'] = _config;

		if (callback || errback) then(callback, errback);

		// ensure next-turn so inline code can execute first
		core.nextTurn(function () {
			when(isPreload || preload, function () {
				when(waitFor, function () { core.getDeps(ctx); }, errback);
			});
		});
	}

	_curl['version'] = version;
	_curl['config'] = _config;

	function _define (args) {

		var id, def, pathInfo;

		id = args.id;

		if (id == undef) {
			if (argsNet !== undef) {
				argsNet = { ex: 'Multiple anonymous defines encountered' };
			}
			else if (!(id = core.getCurrentDefName())/* intentional assignment */) {
				// anonymous define(), defer processing until after script loads
				argsNet = args;
			}
		}
		if (id != undef) {
			// named define(), it is in the cache if we are loading a dependency
			// (could also be a secondary define() appearing in a built file, etc.)
			def = cache[id];
			if (!(id in cache)) {
				// id is an absolute id in this case, so we can get the config.
				pathInfo = core.resolvePathInfo(id, userCfg);
				def = core.createResourceDef(pathInfo.config, id);
				cache[id] = def;
			}
			if (!isPromise(def)) throw new Error('duplicate define: ' + id);
			// check if this resource has already been resolved
			def.useNet = false;
			core.defineResource(def, args);
		}

	}

	function define () {
		// wrap inner _define so it can be replaced without losing define.amd
		var args = core.fixArgs(arguments);
		_define(args);
	}

	// indicate our capabilities:
	define['amd'] = { 'plugins': true, 'jQuery': true, 'curl': version };

	// default configs
	userCfg = {
		baseUrl: '',
		pluginPath: 'curl/plugin',
		dontAddFileExt: dontAddExtRx,
		paths: {},
		packages: {},
		plugins: {},
		pathMap: {},
		pathRx: /$^/
	};

	// handle pre-existing global
	prevCurl = global[curlName];
	prevDefine = global[defineName];

	// only run config if there is something to config (perf saver?)
	if (prevCurl && isType(prevCurl, 'Object')) {
		// remove global curl object
		global[curlName] = undef; // can't use delete in IE 6-8
		// configure curl
		_config(prevCurl);
	}
	else {
		// set default api
		core.setApi();
	}

	// look for "data-curl-run" directive
	bootScript = core.extractDataAttrConfig();
	// wait a bit in case curl.js is bundled into the boot script
	if (bootScript) core.nextTurn(core.bootScript);

	// allow curl to be a dependency
	cache[curlName] = _curl;

	// expose curl core for special plugins and modules
	// Note: core overrides will only work in either of two scenarios:
	// 1. the files are running un-compressed (Google Closure or Uglify)
	// 2. the overriding module was compressed into the same file as curl.js
	// Compiling curl and the overriding module separately won't work.
	cache['curl/_privileged'] = {
		'core': core,
		'cache': cache,
		'config': function () { return userCfg; },
		'_define': _define,
		'_curl': _curl,
		'Promise': Promise
	};

}(this.window || (typeof global != 'undefined' && global) || this));
/** MIT License (c) copyright 2010-2013 B Cavalier & J Hann */

/**
 * curl domReady
 *
 * Licensed under the MIT License at:
 * 		http://www.opensource.org/licenses/mit-license.php
 */

/**
 * usage:
 *  require(['ModuleA', 'curl/domReady'], function (ModuleA, domReady) {
 * 		var a = new ModuleA();
 * 		domReady(function () {
 * 			document.body.appendChild(a.domNode);
 * 		});
 * 	});
 *
 * also: check out curl's domReady! plugin
 *
 * HT to Bryan Forbes who wrote the initial domReady code:
 * http://www.reigndropsfall.net/
 *
 */
(function (global, doc) {

	var
		readyState = 'readyState',
		// keep these quoted so closure compiler doesn't squash them
		readyStates = { 'loaded': 1, 'interactive': 1, 'complete': 1 },
		callbacks = [],
		fixReadyState = doc && typeof doc[readyState] != "string",
		// IE needs this cuz it won't stop setTimeout if it's already queued up
		completed = false,
		pollerTime = 10,
		addEvent,
		remover,
		removers = [],
		pollerHandle,
		undef;

	function ready () {
		completed = true;
		clearTimeout(pollerHandle);
		while (remover = removers.pop()) remover();
		if (fixReadyState) {
			doc[readyState] = "complete";
		}
		// callback all queued callbacks
		var cb;
		while ((cb = callbacks.shift())) {
			cb();
		}
	}

	var testEl;
	function isDomManipulable () {
		// question: implement Diego Perini's IEContentLoaded instead?
		// answer: The current impl seems more future-proof rather than a
		// non-standard method (doScroll). i don't care if the rest of the js
		// world is using doScroll! They can have fun repairing their libs when
		// the IE team removes doScroll in IE 13. :)
		if (!doc.body) return false; // no body? we're definitely not ready!
		if (!testEl) testEl = doc.createTextNode('');
		try {
			// webkit needs to use body. doc
			doc.body.removeChild(doc.body.appendChild(testEl));
			testEl = undef;
			return true;
		}
		catch (ex) {
			return false;
		}
	}

	function checkDOMReady (e) {
		var isReady;
		// all browsers except IE will be ready when readyState == 'interactive'
		// so we also must check for document.body
		isReady = readyStates[doc[readyState]] && isDomManipulable();
		if (!completed && isReady) {
			ready();
		}
		return isReady;
	}

	function poller () {
		checkDOMReady();
		if (!completed) {
			pollerHandle = setTimeout(poller, pollerTime);
		}
	}

	// select the correct event listener function. all of our supported
	// browsers will use one of these
	if ('addEventListener' in global) {
		addEvent = function (node, event) {
			node.addEventListener(event, checkDOMReady, false);
			return function () { node.removeEventListener(event, checkDOMReady, false); };
		};
	}
	else {
		addEvent = function (node, event) {
			node.attachEvent('on' + event, checkDOMReady);
			return function () { node.detachEvent(event, checkDOMReady); };
		};
	}

	if (doc) {
		if (!checkDOMReady()) {
			// add event listeners and collect remover functions
			removers = [
				addEvent(global, 'load'),
				addEvent(doc, 'readystatechange'),
				addEvent(global, 'DOMContentLoaded')
			];
			// additionally, poll for readystate
			pollerHandle = setTimeout(poller, pollerTime);
		}
	}

	define('curl/domReady', function () {

		// this is simply a callback, but make it look like a promise
		function domReady (cb) {
			if (completed) cb(); else callbacks.push(cb);
		}
		domReady['then'] = domReady;
		domReady['amd'] = true;

		return domReady;

	});

}(this, this.document));
/** @license MIT (c) copyright 2010-2013 B Cavalier & J Hann */

/**
 * @module curl/shim/dojo18
 *
 * @description
 *
 * curl dojo 1.8 and 1.9 shim
 *
 * This shim overcomes some issues with dojo 1.8 and 1.9 when used with
 * curl.js as a "foreign loader".
 *
 * Specifics:
 *
 *  1. Adds a global `require` function.
 *  2. Adds a `has` implementation to global and local `require` functions.
 *  3. Adds a `idle` function to global and local `require` functions.
 *  4. Adds a noop `on` function to global and local `require` functions.
 *  5. Copies any curl config.has properties into the `has` implementation
 *     similar to what the dojo loader does.
 *  6. Adds a "null" dojo/_base/loader module to prevent production builds
 *     from trying to load that module.  (This seems compatible with the
 *     same logic dojo uses internally.)
 *  7. Ensures that dojo knows that a foreign loader is being used by
 *     setting the 'dojo-loader' `has` test to true;
 *
 * Many thanks to Bryan Forbes @bryanforbes!
 *
 * @example
 *
 * curl.config({
 *     // <packages, etc. go here>
 *
 *     // load this shim as a preload
 *     preloads: ['curl/shim/dojo18'],
 *
 *     // set any initial has-profile properties
 *     has: { 'mvc-bindings-log-api': 1 }
 * });
 */
var require;
(function (global, doc){
define('curl/shim/dojo18', ['curl/_privileged'], function (priv) {
"use strict";

	var _curl, moduleCache, Promise, origCreateContext;

	_curl = priv['_curl'];
	moduleCache = priv['cache'];
	Promise = priv['Promise'];
	origCreateContext = priv['core'].createContext;

	var hasCache, hasElement, has;

	// grab has profile from user config.
	hasCache = priv.config().has || {};
	// element for has() tests
	hasElement = doc && doc.createElement('div');

	// create has implementation
	has = _has;
	has.add = _add;

	// just in case:
	hasCache['dojo-loader'] = false;

	// production builds of dojo assume the sync loader exists.
	// this will prevent anything from trying to use it:
	moduleCache['dojo/_base/loader'] = 0;

	// ugh! dojo 1.9 still expects a global `require` in at least one
	// place: dojo/_base/browser. so make sure it's got one.
	if (typeof require == 'undefined') {
		duckPunchRequire(_curl);
		require = _curl;
	}

	// override createContext to override "local require"
	priv['core'].createContext = function () {
		var def = origCreateContext.apply(this, arguments);
		duckPunchRequire(def.require);
		return def;
	};

	return true;

	function _has (name) {
		// dojo-ish has implementation
		return typeof hasCache[name] == 'function'
			? (hasCache[name] = hasCache[name](global, doc, hasElement))
			: hasCache[name];
	}

	function _add (name, test, now, force) {
		if (hasCache[name] === undefined || force) {
			hasCache[name] = test;
		}
		if (now) {
			return has(name);
		}
	}

	function duckPunchRequire (req) {
		// create a functioning has() for built dojos (1.8 and 1.9)
		if (!req['has']) {
			req['has'] = has;
		}
		// create a stub for on() for dojo 1.8.x
		if (!req['on']) {
			req['on'] = noop;
		}
		// create an idle() for dojo 1.8.x
		if (!req['idle']) {
			req['idle'] = idle;
		}
		// tell dojo to always load async
		req.async = true;
		return req;
	}

	function idle () {
		// looks for unresolved defs in the cache
		for (var id in moduleCache) {
			if (moduleCache[id] instanceof Promise) return false;
		}
		return true;
	}

	function noop () {}

});
}(
	typeof global == 'object' ? global : this.window || this.global,
	typeof document == 'object' && document
));
/** MIT License (c) copyright 2010-2013 B Cavalier & J Hann */

/**
 * curl js! plugin
 *
 * Licensed under the MIT License at:
 * 		http://www.opensource.org/licenses/mit-license.php
 *
 */

/**
 * usage:
 *  require(['ModuleA', 'js!myNonAMDFile.js!order', 'js!anotherFile.js!order], function (ModuleA) {
 * 		var a = new ModuleA();
 * 		document.body.appendChild(a.domNode);
 * 	});
 *
 * Specify the !order suffix for files that must be evaluated in order.
 * Using the !order option and requiring js files more than once doesn't make
 * much sense since files are loaded exactly once.
 *
 * Specify the !exports=someGlobalVar option to return a global variable to
 * the module depending on the javascript file. Using this option also allows
 * positive error feedback to the loader since it can now detect if the
 * javascript file failed to load correctly.
 *
 * Async=false rules learned from @getify's LABjs!
 * http://wiki.whatwg.org/wiki/Dynamic_Script_Execution_Order
 *
 */
(function (global, doc, testGlobalVar) {
define('curl/plugin/js', ['curl/_privileged'], function (priv) {
"use strict";
	var cache = {},
		queue = [],
		supportsAsyncFalse = doc && doc.createElement('script').async == true,
		Promise,
		waitForOrderedScript,
		dontAddExtRx = /\?|\.js\b/;

	Promise = priv['Promise'];

	function nameWithExt (name, defaultExt) {
		return name.lastIndexOf('.') <= name.lastIndexOf('/') ?
			name + '.' + defaultExt : name;
	}

	function loadScript (def, success, failure) {
		// script processing rules learned from RequireJS

		var deadline, completed, el;

		// default deadline is very far in the future (5 min)
		// devs should set something reasonable if they want to use it
		deadline = new Date().valueOf() + (def.timeoutMsec || 300000);

		// initial script processing
		function process () {
			completed = true;
			if (def.exports) def.resolved = testGlobalVar(def.exports);
			if (!def.exports || def.resolved) {
				success(el); // pass el so it can be removed (text/cache)
			}
			else {
				failure();
			}
		}

		function fail (ex) {
			// Exception is squashed by curl.js unfortunately
			completed = true;
			failure(ex);
		}

		// some browsers (Opera and IE6-8) don't support onerror and don't fire
		// readystatechange if the script fails to load so we need to poll.
		// this poller only runs if def.exports is specified and failure callback
		// is defined (see below)
		function poller () {
			// if the script loaded
			if (!completed) {
				// if neither process or fail as run and our deadline is in the past
				if (deadline < new Date()) {
					failure();
				}
				else {
					setTimeout(poller, 10);
				}
			}
		}
		if (failure && def.exports) setTimeout(poller, 10);

		el = priv['core'].loadScript(def, process, fail);

	}

	function fetch (def, promise) {

		loadScript(def,
			function () {
				// if there's another queued script
				var next = queue.shift();
				waitForOrderedScript = queue.length > 0;
				if (next) {
					// go get it (from cache hopefully)
					fetch.apply(null, next);
				}
				promise.resolve(def.resolved || true);
			},
			function (ex) {
				promise.reject(ex);
			}
		);

	}

	return {

		// the !options force us to cache ids in the plugin and provide normalize
		'dynamic': true,

		'normalize': function (id, toAbsId, config) {
			var end = id.indexOf('!');
			return end >= 0 ? toAbsId(id.substr(0, end)) + id.substr(end) : toAbsId(id);
		},

		'load': function (resId, require, callback, config) {

			var order, exportsPos, exports, prefetch, dontAddFileExt,
				url, def, promise;

			order = resId.indexOf('!order') > 0; // can't be zero
			exportsPos = resId.indexOf('!exports=');
			exports = exportsPos > 0
				? resId.substr(exportsPos + 9) // must be last option!
				: config.exports;
			prefetch = 'prefetch' in config ? config['prefetch'] : true;
			resId = order || exportsPos > 0
				? resId.substr(0, resId.indexOf('!'))
				: resId;
			// add extension afterwards so js!-specific path mappings don't
			// need extension, too.
			dontAddFileExt = config['dontAddFileExt'] || config.dontAddFileExt;
			dontAddFileExt = dontAddFileExt
				? new RegExp(dontAddFileExt)
				: dontAddExtRx;

			url = require['toUrl'](resId);
			if (!dontAddFileExt.test(url)) {
				url = nameWithExt(url, 'js');
			}

			function reject (ex) {
				(callback['error'] || function (ex) { throw ex; })(ex);
			}

			// if we've already fetched this resource, get it out of the cache
			if (url in cache) {
				if (cache[url] instanceof Promise) {
					cache[url].then(callback, reject);
				}
				else {
					callback(cache[url]);
				}
			}
			else {
				def = {
					name: resId,
					url: url,
					order: order,
					exports: exports,
					timeoutMsec: config['timeout']
				};
				cache[url] = promise = new Promise();
				promise.then(
					function (o) {
						cache[url] = o;
						callback(o);
					},
					reject
				);

				// if this script has to wait for another
				// or if we're loading, but not executing it
				if (order && !supportsAsyncFalse && waitForOrderedScript) {
					// push onto the stack of scripts that will be fetched
					// from cache. do this before fetch in case IE has file cached.
					queue.push([def, promise]);
					// if we're prefetching
					if (prefetch) {
						// go get the file under an unknown mime type
						def.mimetype = 'text/cache';
						loadScript(def,
							// remove the fake script when loaded
							function (el) { el && el.parentNode.removeChild(el); },
							function () {}
						);
						def.mimetype = '';
					}
				}
				// otherwise, just go get it
				else {
					waitForOrderedScript = waitForOrderedScript || order;
					fetch(def, promise);
				}
			}

		},

		'cramPlugin': '../cram/js'

	};
});
}(
	this,
	this.document,
	function () { try { return eval(arguments[0]); } catch (ex) { return; } }
));
define('curl/plugin/_fetchText', [], function () {

	var xhr, progIds;

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

	function fetchText (url, callback, errback) {
		var x = xhr();
		x.open('GET', url, true);
		x.onreadystatechange = function (e) {
			if (x.readyState === 4) {
				if (x.status < 400) {
					callback(x.responseText);
				}
				else {
					errback(new Error('fetchText() failed. status: ' + x.statusText));
				}
			}
		};
		x.send(null);
	}

	return fetchText;

});
/** MIT License (c) copyright 2010-2013 B Cavalier & J Hann */

/**
 * curl text! loader plugin
 *
 * Licensed under the MIT License at:
 * 		http://www.opensource.org/licenses/mit-license.php
 */

/**
 * TODO: load xdomain text, too, somehow
 *
 */

define('curl/plugin/text', ['./_fetchText'], function (fetchText) {

	return {

//		'normalize': function (resourceId, toAbsId) {
//			// remove options
//			return resourceId ? toAbsId(resourceId.split("!")[0]) : resourceId;
//		},

		load: function (resourceName, req, callback, config) {
			// remove suffixes (future)
			// get the text
			fetchText(req['toUrl'](resourceName), callback, callback['error'] || error);
		},

		'cramPlugin': '../cram/text'

	};

	function error (ex) {
		throw ex;
	}

});
/** MIT License (c) copyright 2010-2013 B Cavalier & J Hann */

/**
 * curl async! plugin
 *
 * Licensed under the MIT License at:
 * 		http://www.opensource.org/licenses/mit-license.php
 *
 */
/*
	async plugin takes another module as it's resource and defers callback
	until that module is complete.  the module must return a promise-like
	object (i.e. has a then method). usage:

	// module that depends upon a deferred (async) resource:
	define(['async!deferredResource'], function (deferredResource) {
		// use deferredResource
	});

	// deferredResource:
	define(function () {
		var resolved, queue, undef;
		queue = [];
		function fetchResource () {
			// go get the resource and call loaded when done
		}
		function loaded (resource) {
			var callback;
			resolved = resource;
			while ((callback = queue.pop()) callback(resolved);
		}
		return {
			then: function (callback, errback) {
				if (resolved != undef) callback(resolved); else queue.push(callback);
			}
		};
	});

*/
define('curl/plugin/async', function () {

	return {

		'load': function (resourceId, require, callback, config) {

			function rejected (error) {
				// report that an error happened
				if (typeof callback.error == 'function') {
					// promise-like callback
					callback.error(error);
				}
				// no way to report errors if the callback doesn't have error()
			}

			// go get the module in the standard way
			require([resourceId], function (module) {

				if (typeof module.then == 'function') {
					// promise-like module
					module.then(
						function (resource) {
							if (arguments.length == 0) resource = module;
							callback(resource);
						},
						rejected
					);
				}
				else {
					// just a normal module
					callback(module);
				}
			}, callback['error'] || function (ex) { throw ex; });
		},

		// for cram's analyze phase
		'analyze': function (resourceId, api, addDep) {
			addDep(resourceId);
		}

	}

});
/** MIT License (c) copyright 2010-2013 B Cavalier & J Hann */

/**
 * curl css! plugin
 *
 * Licensed under the MIT License at:
 * 		http://www.opensource.org/licenses/mit-license.php
 *
 */

(function (global) {
"use strict";

/*
 * AMD css! plugin
 * This plugin will load and wait for css files.  This could be handy when
 * loading css files as part of a component or a theme.
 * Some browsers do not support the load event handler of the link element.
 * Therefore, we have to use other means to detect when a css file loads.
 * Some browsers don't support the error event handler, either.
 * The HTML5 spec states that the LINK element should have both load and
 * error events:
 * http://www.w3.org/TR/html5/semantics.html#the-link-element
 *
 * This plugin tries to use the load event and a universal work-around when
 * it is invoked.  If the load event works, it is used on every successive load.
 * Therefore, browsers that support the load event will just work (i.e. no
 * need for hacks!).  FYI, sniffing for the load event is tricky
 * since most browsers still have a non-functional onload property.
 *
 * IE is a special case since it also has a 31-stylesheet limit (finally
 * fixed in IE 10).  To get around this, we can use a set of <style>
 * elements instead of <link> elements and add @import; rules into them.
 * This allows us to add considerably more than 31 stylesheets.  See the
 * comment for the loadImport method for more information.
 *
 * The universal work-around for other browsers watches a stylesheet
 * until its rules are available (not null or undefined).  There are
 * nuances, of course, between the various browsers.  The isLinkReady
 * function accounts for these.
 *
 * Note: it appears that all browsers load @import'ed stylesheets before
 * fully processing the rest of the importing stylesheet. Therefore, we
 * don't need to find and wait for any @import rules explicitly.  They'll
 * be waited for implicitly.
 *
 * Global configuration options:
 *
 * cssNoWait: Boolean. You can instruct this plugin to not wait
 * for any css resources. They'll get loaded asap, but other code won't wait
 * for them.  Note: you cannot use this option and use more than 31
 * stylesheets in IE6-9!
 *
 * cssWatchPeriod: if direct load-detection techniques fail, this option
 * determines the msec to wait between brute-force checks for rules. The
 * default is 50 msec.
 *
 * You may specify an alternate file extension or no extension:
 *      require('css!myproj/component.less') // --> myproj/component.less
 *      require('css!myproj/component') // --> myproj/component.css
 *
 * When using alternative file extensions, be sure to serve the files from
 * the server with the correct mime type (text/css) or some browsers won't
 * parse them, causing an error.
 *
 * usage:
 *      require(['css!myproj/comp.css']); // load and wait for myproj/comp.css
 *      define(['css!some/folder/file'], {}); // wait for some/folder/file.css
 *      require(['css!myWidget']);
 *
 * Tested in:
 *      Firefox 3.6, 4.0, 11-16
 *      Safari 3.0.4, 3.2.1, 5.0
 *      Chrome 19
 *      Opera 11.62, 12.01
 *      IE 6-10
 *  Error handlers work in the following:
 *  	Firefox 12+
 *  	Safari 6+
 *  	Chrome 9+
 *  	IE6-9
 *  Error handlers don't work in:
 *  	Opera 11.62, 12.01
 *  	Firefox 3.6, 4.0
 *  	IE 10
*/

	var
		// compressibility shortcuts
		createElement = 'createElement',
		parentNode = 'parentNode',
		setTimeout = global.setTimeout,
		// doc will be undefined during a build
		doc = global.document,
		// find the head element and set it to it's standard property if nec.
		head,
		// infer IE 6-9
		// IE 10 still doesn't seem to have link.onerror support,
		// but it doesn't choke on >31 stylesheets at least!
		shouldCollectSheets = doc && doc.createStyleSheet && !(doc.documentMode >= 10),
		ieCollectorSheets = [],
		ieCollectorPool = [],
		ieCollectorQueue = [],
		ieMaxCollectorSheets = 12,
		loadSheet,
		msgHttp = 'HTTP or network error.',
		hasEvent = {};

	if (doc) {
		head = doc.head || doc.getElementsByTagName('head')[0];
		if (shouldCollectSheets) {
			loadSheet = loadImport;
		}
		else {
			loadSheet = loadLink;
		}
	}

	/**
	 * Once we've absolutely determined if the current browser supports an
	 * event handler, we set it with this function.
	 * @private
	 * @param event
	 * @param hasNative
	 */
	function setLoadDetection (event, hasNative) {
		hasEvent[event] = hasEvent[event] || hasNative;
	}

	/**
	 * Creates a link element.
	 * IE6-9 don't use this function.
	 * @private
	 * @return {Element}
	 */
	function createLink () {
		var link;
		link = doc[createElement]('link');
		link.rel = "stylesheet";
		link.type = "text/css";
		return link;
	}

	/***** load functions for compliant browsers *****/

	/**
	 * This is the load handler for compliant browsers.
	 * Latest Chrome, Safari, Opera, FF, IE10
	 * @private
	 * @param link
	 * @param cb
	 */
	function loadHandler (link, cb) {
		link.onload = function () {
			// we know browser is compliant now!
			setLoadDetection('load', true);
			cb();
		};
	}

	/**
	 * This is the load handler for compliant browsers.
	 * Latest Chrome, Safari (not Opera 12 or IE10)
	 * @private
	 * @param link
	 * @param cb
	 */
	function errorHandler (link, cb) {
		link.onerror = function () {
			// we know browser is compliant now!
			setLoadDetection('error', true);
			cb();
		};
	}

	/***** ie load functions *****/

	/**
	 * Loads a stylesheet via IE's addImport() method, which is the only
	 * way to detect both onload and onerror in IE.  If we create a "parent
	 * stylesheet", we can addImport() other sheets into it.  The tricky part
	 * is that we have to load one sheet at a time and create a new onload
	 * and onerror event for each one.  (IE only fires an onload or onerror
	 * function once, but if you replace the onload or onerror functions,
	 * it'll fire the new ones if there's another load or error event.
	 * Way to be awesome, IE team!)
	 *
	 * To get around the one-sheet-at-a-time problem, we create many
	 * parent stylesheets at once.  If we create 12 parent sheets, we can load
	 * up to 12 imported sheets at once.  This has an additional benefit:
	 * we can load 372 (12 * 31) stylesheets.  IE 6-9 can dynamically load only
	 * 31 stylesheets in any one scope.  By creating multiple parent sheets, we
	 * create multiple scopes.
	 *
	 * The astute reader will have discovered a major flaw with this approach:
	 * we've killed the cascade (the "C" in CSS).  Rules in stylesheets override
	 * rules in stylesheets that were declared earlier.  This is universal.
	 * However, the IE team interpreted the word "earlier" differently than
	 * everybody else (including the w3c).  IE interprets it as meaning "earlier
	 * in time" (temporal), rather than "earlier in the document" (spacial).
	 * Specifically, the temporal order of the insertion of the sheet into the
	 * DOM/BOM is what matters in IE.
	 *
	 * In other words: the bungling of the IE team (both in allowing sheet
	 * error handlers to execute multiple times and in forcing us to use
	 * temporal order rather than dom order) has allowed us to implement
	 * this work-around.  Almost seems like they planned it.
	 *
	 * Note: CSS debugging tools in IE 6-8 seem to sometimes fail when inserting
	 * stylesheets dynamically, no matter which method we use to insert them.
	 *
	 * IE 6-9 only.
	 * @private
	 * @param url {String}
	 * @param cb {Function}
	 * @param eb {Function}
	 */
	function loadImport (url, cb, eb) {
		var coll;

		// push stylesheet and callbacks on queue
		ieCollectorQueue.push({
			url:url,
			cb:cb,
			eb: function failure () { eb(new Error(msgHttp)); }
		});

		// find an available collector
		coll = getIeCollector();

		// if we have an available collector, import a stylesheet from the queue
		if (coll) {
			loadNextImport(coll);
		}

	}

	/**
	 * Grabs the next sheet/callback item from the queue and imports it into
	 * the provided collector sheet.
	 * IE 6-9 only.
	 * @private
	 * @param coll {Stylesheet}
	 */
	function loadNextImport (coll) {
		var imp, collSheet;

		imp = ieCollectorQueue.shift();
		collSheet = coll.styleSheet;

		if (imp) {
			coll.onload = function () {
				imp.cb(imp.ss);
				loadNextImport(coll);
			};
			coll.onerror = function () {
				imp.eb();
				loadNextImport(coll);
			};
			imp.ss = collSheet.imports[collSheet.addImport(imp.url)];
		}
		else {
			finalize(coll);
			returnIeCollector(coll);
		}
	}

	/**
	 * Returns a collector sheet to the pool.
	 * IE 6-9 only.
	 * @private
	 * @param coll {Stylesheet}
	 */
	function returnIeCollector (coll) {
		ieCollectorPool.push(coll);
	}

	/**
	 * Gets the next collector sheet in the pool.  If there is no collector
	 * in the pool and less than the maximum collector sheets has been created,
	 * a new one is created. If the max collectors have been created,
	 * undefined is returned.
	 * IE 6-9 only.
	 * @private
	 * @return {HTMLElement} a stylesheet element to act as a collector sheet
	 */
	function getIeCollector () {
		var el;

		el = ieCollectorPool.shift();

		if (!el && ieCollectorSheets.length < ieMaxCollectorSheets) {
			el = doc.createElement('style');
			ieCollectorSheets.push(el);
			head.appendChild(el);
		}

		return el;
	}

	/***** load functions for legacy browsers (old Safari and FF, Opera) *****/

	/**
	 * Try all sorts of crazy shiz to determine when the stylesheet is loaded.
	 * @private
	 * @param link
	 * @return {Boolean}
	 */
	function isLinkReady (link) {
		var ready, sheet, rules;
		// don't bother testing until we've fully initialized the link and doc.
		if (!link.href || !isDocumentComplete()) return false;

		ready = false;
		try {
			sheet = link.sheet;
			if (sheet) {
				// old FF will throw a security exception here when an XD
				// sheet is loaded. webkits (that don't support onload)
				// will return null when an XD sheet is loaded
				rules = sheet.cssRules;
				ready = rules === null;
				if (!ready && rules) {
					// Safari needs to further test for rule manipulation
					// on local stylesheets (Opera too?)
					sheet.insertRule('-curl-css-test {}', 0);
					sheet.deleteRule(0);
					ready = true;
				}
			}
		}
		catch (ex) {
			// a "security" or "access denied" error indicates that an XD
			// stylesheet has been successfully loaded in old FF
			// Opera throws before the sheet is loaded (and before onload
			// in some cases, so we have to test for it here)
			ready = Object.prototype.toString.call(window.opera) != '[object Opera]'
				&& /security|denied/i.test(ex.message);
		}

		return ready;
	}

	/**
	 * Indicate that a link element is loaded or errored.
	 * @private
	 * @param link
	 */
	function finalize (link) {
		// noop serves as a flag that a link event fired
		// note: Opera and IE won't clear handlers if we use a non-function
		link.onload = link.onerror = noop;
	}

	/**
	 * Detect is a link is loaded or errored.
	 * @private
	 * @param link
	 * @return {Boolean}
	 */
	function isFinalized (link) {
		return link.onload == noop || !link.onload;
	}

	/**
	 * This is the function that will be used when a browser doesn't support
	 * the standard onload and handler -- or until we've verified that the
	 * browser supports it.
	 * @private
	 * @param link
	 * @param wait {Number} msec between checks
	 * @param cb
	 */
	function loadWatcher (link, wait, cb) {
		// watches a stylesheet for loading signs.
		if (hasEvent['load']) return; // always check on re-entry
		if (isLinkReady(link)) {
			cb(link.sheet);
		}
		else if (!isFinalized(link)) {
			setTimeout(function () { loadWatcher(link, wait, cb); }, wait);
		}
	}

	/**
	 * This is the function that wil be used when a browser doens't support
	 * the standard onerror handler -- or until we've verifies that the
	 * browser supports it.
	 * Note: so far we don't have a good way to check or failed stylesheets
	 * without attempting to refetch the stylesheet using an IMG, OBJECT,
	 * or any other means, so we haven't implemented this.
	 * @private
	 * @param link
	 * @param wait {Number} msec between checks
	 * @param eb
	 */
	function errorWatcher (link, wait, eb) {
		if (hasEvent['error']) return;
		// TODO: figure out a method to test for stylesheet failure without risk of re-fetching
		// TODO: timeout?
	}

	/**
	 * Launch both standards-compliant onload and fallback at the same time.
	 * One of these will eventually work.
	 * @private
	 * @param link
	 * @param wait {Number} msec between checks
	 * @param cb
	 */
	function linkLoaded (link, wait, cb) {
		// most browsers now support link.onload, but many older browsers
		// don't. Browsers that don't will launch the loadWatcher to repeatedly
		// test the link for readiness.
		function load () {
			// only executes once (link.onload is acting as a flag)
			if (isFinalized(link)) return;
			finalize(link);
			waitForDocumentComplete(function () { cb(link.sheet); });
		}
		// always try standard handler
		loadHandler(link, load);
		// also try the fallback
		loadWatcher(link, wait, load);
	}

	/**
	 * Launch both standards-compliant onerror and fallback at the same time.
	 * One of these will eventually work in most browsers.
	 * @private
	 * @param link
	 * @param wait {Number} msec between checks
	 * @param cb
	 */
	function linkErrored (link, wait, cb) {
		// very few browsers (Chrome 19+ and FF9+ as of Apr 2012) have a
		// functional onerror handler (and those only detect 40X/50X http
		// errors, not parsing errors as per the w3c spec).
		// IE6-10 call onload when there's an http error. (nice, real nice)
		// this only matters in IE10 since IE6-9 use the addImport method
		// which does call onerror.
		function error () {
			// only executes once (link.onload is acting as a flag)
			if (isFinalized(link)) return;
			finalize(link);
			cb(new Error(msgHttp));
		}
		// always try standard handler
		errorHandler(link, error);
		// if we are not sure if the native error event works, try the fallback
		errorWatcher(link, wait, error);
	}

	/**
	 * Kick-start the load and detection process.
	 * @private
	 * @param url
	 * @param cb
	 * @param eb
	 * @param period {Number} msec between checks
	 */
	function loadLink (url, cb, eb, period) {
		var link;
		link = createLink();
		linkLoaded(link, period, cb);
		linkErrored(link, period, eb);
		link.href = url;
		head.appendChild(link);
	}

	/**
	 * Keep checking for the document readyState to be "complete" since
	 * Chrome doesn't apply the styles to the document until that time.
	 * If we return before readyState == 'complete', Chrome may not have
	 * applied the styles, yet.
	 * Chrome only.
	 * @private
	 * @param cb
	 */
	function waitForDocumentComplete (cb) {
		// this isn't exactly the same as domReady (when dom can be
		// manipulated). it's later (when styles are applied).
		// chrome needs this (and opera?)
		function complete () {
			if (isDocumentComplete()) {
				cb();
			}
			else {
				setTimeout(complete, 10);
			}
		}
		complete();
	}

	/**
	 * Returns true if the documents' readyState == 'complete' or the
	 * document doesn't implement readyState.
	 * Chrome only.
	 * @private
	 * @return {Boolean}
	 */
	function isDocumentComplete () {
		return !doc.readyState || doc.readyState == 'complete';
	}

	function nameWithExt (name, defaultExt) {
		return name.lastIndexOf('.') <= name.lastIndexOf('/') ?
			name + '.' + defaultExt : name;
	}

	function noop () {}

	/***** finally! the actual plugin *****/

	define('curl/plugin/css', {

		'normalize': function (resourceId, normalize) {
			var resources, normalized;

			if (!resourceId) return resourceId;

			resources = resourceId.split(",");
			normalized = [];

			for (var i = 0, len = resources.length; i < len; i++) {
				normalized.push(normalize(resources[i]));
			}

			return normalized.join(',');
		},

		'load': function (resourceId, require, callback, config) {
			var sheets, resources, cssWatchPeriod, cssNoWait, loadingCount, i;
			sheets = [];
			resources = (resourceId || '').split(",");
			cssWatchPeriod = config['cssWatchPeriod'] || 50;
			cssNoWait = config['cssNoWait'];
			loadingCount = resources.length;

			// this function must get called just once per stylesheet!
			function loaded (ss) {
				if (resources.length > 1) sheets.push(ss);
				if (--loadingCount == 0) {
					callback(resources.length == 1 ? ss : sheets);
				}
			}

			function failed (ex) {
				var eb;
				eb = callback.reject || function (ex) {
					throw ex;
				};
				eb(ex);
			}

			for (i = 0; i < resources.length; i++) {

				resourceId = resources[i];

				var url, link;
				url = nameWithExt(require['toUrl'](resourceId), 'css');

				if (cssNoWait) {
					link = createLink();
					link.href = url;
					head.appendChild(link);
					loaded(link.sheet || link.styleSheet);
				}
				else {
					loadSheet(url, loaded, failed, cssWatchPeriod);
				}
			}

		},

		'cramPlugin': '../cram/css'

	});

})(this);
/** MIT License (c) copyright 2010-2013 B Cavalier & J Hann */

/**
 * curl link! plugin
 *
 * Licensed under the MIT License at:
 * 		http://www.opensource.org/licenses/mit-license.php
 *
 */

(function (global) {
"use strict";

/*
 * curl link! plugin
 * This plugin will load css files as <link> elements.  It does not wait for
 * css file to finish loading / evaluating before executing dependent modules.
 * This plugin also does not handle IE's 31-stylesheet limit.
 * If you need any of the above behavior, use curl's css! plugin instead.
 *
 * All this plugin does is insert <link> elements in a non-blocking manner.
 *
 * usage:
 * 		// load myproj/comp.css and myproj/css2.css
 *      require(['link!myproj/comp,myproj/css2']);
 *      // load some/folder/file.css
 *      define(['css!some/folder/file'], {});
 *
 * Tested in:
 *      Firefox 1.5, 2.0, 3.0, 3.5, 3.6, and 4.0b6
 *      Safari 3.0.4, 3.2.1, 5.0
 *      Chrome 7+
 *      Opera 9.52, 10.63, and Opera 11.00
 *      IE 6, 7, and 8
 *      Netscape 7.2 (WTF? SRSLY!)
 * Does not work in Safari 2.x :(
*/


	var
		// compressibility shortcuts
		createElement = 'createElement',
		// doc will be undefined during a build
		doc = global.document,
		// regexp to find url protocol for IE7/8 fix (see fixProtocol)
		isProtocolRelativeRx = /^\/\//,
		// find the head element and set it to it's standard property if nec.
		head;

	if (doc) {
		head = doc.head || (doc.head = doc.getElementsByTagName('head')[0]);
	}

	function nameWithExt (name, defaultExt) {
		return name.lastIndexOf('.') <= name.lastIndexOf('/') ?
			name + '.' + defaultExt : name;
	}

	function createLink (doc, href) {
		var link = doc[createElement]('link');
		link.rel = "stylesheet";
		link.type = "text/css";
		link.href = href;
		return link;
	}

	function fixProtocol (url, protocol) {
		// IE 7 & 8 can't handle protocol-relative urls:
		// http://www.stevesouders.com/blog/2010/02/10/5a-missing-schema-double-download/
		return url.replace(isProtocolRelativeRx, protocol + '//');
	}

	define('curl/plugin/link', {

//		'normalize': function (resourceId, toAbsId) {
//			// remove options
//			return resourceId ? toAbsId(resourceId.split("!")[0]) : resourceId;
//		},

		'load': function (resourceId, require, callback, config) {
			var url, link, fix;

			url = nameWithExt(require['toUrl'](resourceId), 'css');
			fix = 'fixSchemalessUrls' in config ? config['fixSchemalessUrls'] : doc.location.protocol;
			url = fix ? fixProtocol(url, fix) : url;
			link = createLink(doc, url);
			head.appendChild(link);

			callback(link.sheet || link.styleSheet);

		}

	});

})(this);
/** MIT License (c) copyright 2010-2013 B Cavalier & J Hann */

/**
 * curl json! plugin
 *
 * Like the text! plugin, will only load same-domain resources.
 */

(function (globalEval) {
define('curl/plugin/json', ['./_fetchText'], function (fetchText) {

	var hasJsonParse, missingJsonMsg;

	hasJsonParse = typeof JSON != 'undefined' && JSON.parse;
	missingJsonMsg = 'Cannot use strictJSONParse without JSON.parse';

	return {

		load: function (absId, require, loaded, config) {
			var evaluator, errback;

			errback = loaded['error'] || error;

			// create a json evaluator function
			evaluator = config.strictJSONParse
				? guard(parseSource, loaded, errback)
				: guard(evalSource, loaded, errback);

			// get the text, then eval it
			fetchText(require['toUrl'](absId), evaluator, errback);

		},

		'cramPlugin': '../cram/json'

	};

	function error (ex) {
		throw ex;
	}

	function evalSource (source) {
		return globalEval('(' + source + ')');
	}

	function parseSource (source) {
		if (!hasJsonParse) throw new Error(missingJsonMsg);
		return JSON.parse(source);
	}

	function guard (evaluator, success, fail) {
		return function (source) {
			var value;
			try {
				value = evaluator(source);
			}
			catch (ex) {
				return fail(ex);
			}
			return success(value);
		}
	}

});
}(
	function () {/*jshint evil:true*/ return (1,eval)(arguments[0]); }
));
/** MIT License (c) copyright 2010-2013 B Cavalier & J Hann */

/**
 * curl domReady loader plugin
 *
 * Licensed under the MIT License at:
 * 		http://www.opensource.org/licenses/mit-license.php
 *
 */

/**
 *
 * allows the curl/domReady module to be used like a plugin
 * this is for better compatibility with other loaders.
 *
 * Usage:
 *
 * curl(["domReady!"]).then(doSomething);
 *
 * TODO: use "../domReady" instead of "curl/domReady" when curl's make.sh is updated to use cram
 */

define('curl/plugin/domReady', ['../domReady'], function (domReady) {

	return {

		'load': function (name, req, cb, cfg) {
			domReady(cb);
		}

	};

});
/** MIT License (c) copyright 2010-2013 B Cavalier & J Hann */

/**
 * curl legacy loader
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
define('curl/loader/legacy', ['curl/_privileged'], function (priv) {
"use strict";
	var hasAsyncFalse, loadScript, dontAddExtRx;

	hasAsyncFalse = doc && doc.createElement('script').async == true;
	loadScript = priv['core'].loadScript;
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
				loadScript(options, _export, reject);
			}

			function reload () {
				// if we faked the mimetype, we need to refetch.
				// (hopefully, from cache, if cache headers allow.)
				options.mimetype = '';
				loadScript(options, _export, reject);
			}

			function _export () {
				var exported;
				if (--countdown > 0) return;
				if (factory) {
					try {
						exported = factory.call(global, resId);
					}
					catch (ex) {
						reject(new Error('Factory for legacy ' + resId + ' failed: ' + ex.message));
					}
				}
				else {
					try {
						exported = testGlobalVar(exports);
					}
					catch (ex) {
						reject(new Error ('Failed to find exports ' + exports + ' for legacy ' + resId));
					}
				}
				// define the module as if it were a regular module.
				// Note: the parens hide the "define signature" from cram.js
				(define)(resId, exported);
				// also return the plugin-syntax module ("legacy!foo").
				callback(exported);
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
define('curl/loader/legacyPrefetch', ['curl/_privileged'], function (priv) {
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
	loadScript = function (options, _export, reject) {
		//this is a simple implementation that only prefetches the content and does not create any JS objects
		//useful for using spare network/CPU cycles to start loading libraries that will be needed in the future.
		var x = xhr();
		x.open('GET', options.url, true);
		x.onreadystatechange = function (e) {
			if (x.readyState === 4) {
				if (x.status < 400) {
					//callback(x.responseText);
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
				loadScript(options, _export, reject);
			}

			function reload () {
				// if we faked the mimetype, we need to refetch.
				// (hopefully, from cache, if cache headers allow.)
				options.mimetype = '';
				loadScript(options, _export, reject);
			}

			function _export () {
				var exported;
				if (--countdown > 0) return;
				if (factory) {
					try {
						exported = factory.call(global, resId);
					}
					catch (ex) {
						reject(new Error('Factory for legacy ' + resId + ' failed: ' + ex.message));
					}
				}
				else {
					try {
						exported = testGlobalVar(exports);
					}
					catch (ex) {
						reject(new Error ('Failed to find exports ' + exports + ' for legacy ' + resId));
					}
				}
				// define the module as if it were a regular module.
				// Note: the parens hide the "define signature" from cram.js
				(define)(resId, exported);
				// also return the plugin-syntax module ("legacy!foo").
				callback(exported);
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
