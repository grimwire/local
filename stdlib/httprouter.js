// HTTP Router
// ===========
// routes http messages to js handler functions

if (typeof HttpRouter == 'undefined') {
	(function() {
		globals.HttpRouter = function HttpRouter() {
			this.servers = [];
			this.response_cbs = [];
			this.cur_mid = 1;
			this.ajax_config = {
				proxy:null,
				proxy_query_header:'x-proxy-query'
			};
		};

		// Configures the server into the uri structure
		//  - maintains precedence in ordering according to the URI
		//    '#/a' is before '#/a/b' is before '#/a/b/c'
		//  - a duplicate URI is inserted after existing servers
		HttpRouter.prototype.addServer = function HttpRouter__addServer(new_uri, server) {
			var new_uri_slashes_count = new_uri.split('/').length;
			for (var i=0; i < this.servers.length; i++) {
				// Lower URI? done
				var existing_uri = this.servers[i].uri;
				if ((existing_uri.indexOf(new_uri) == 0) && (new_uri_slashes_count < existing_uri.split('/').length)) {
					break;
				}
			}
			this.servers.splice(i, 0, { uri:new_uri, inst:server });
		};

		// Removes all matching servers from the structure
		//  - non-regexp `uri` must be an exact match
		HttpRouter.prototype.removeServers = function HttpRouter__removeServers(uri) {
			var isregex = (uri instanceof RegExp);
			var test = isregex ? uri.test : function(v) { return this == v; };
			this.servers.forEach(function(m, i) {
				if (test.call(uri, m.uri)) {
					this.servers.splice(i, 1);
				}
			}, this);
		};

		// Searches servers for handlers for the given request
		//  - returns an array of objects with the keys { cb, server, match, route }
		//  - returns the handlers in the order of server precedence
		function HttpRouter__findHandlers(request) {
			var matched_handlers = [];
			this.servers.forEach(function(server) {
				var rel_uri_index = request.uri.indexOf(server.uri);
				if (rel_uri_index == 0) {

					// is it a complete name match? (/foo matches /foo/bar, not /foobar)
					var rel_uri = request.uri.substr(server.uri.length);
					/*if (rel_uri != '' && rel_uri.charAt(0) != '/') { //:TODO: better way to check this
						return [];
					}*/
					if (rel_uri.charAt(0) != '/') { rel_uri = '/' + rel_uri; } // prepend the leading slash, for consistency

					for (var j=0; j < server.inst.routes.length; j++) {
						var route = server.inst.routes[j];
						var match, matches = {};
						for (var k in route.match) {
							match = true;

							if (!(k in request)) {
								Util.log('routing', ' > ',/*server.inst,*/route.cb,'MISS ('+k+')');
								match = false;
								break;
							}

							// convert strings to regexps
							if (typeof(route.match[k]) == 'string') { route.match[k] = new RegExp(route.match[k], 'i'); }

							// test for match
							var reqVal = (k == 'uri' ? rel_uri : request[k]);
							if (route.match[k] instanceof RegExp) {
								match = route.match[k].exec(reqVal)
								if (!match) { 
									Util.log('routing', ' > ',/*server.inst,*/route.cb,'MISS ('+k+' "'+reqVal+'")');
									break; 
								}
								matches[k] = match;
							}
							else {
								if (route.match[k] != reqVal) { 
									Util.log('routing', ' > ',/*server.inst,*/route.cb,'MISS ('+k+' "'+reqVal+'")');
									match = false; break; 
								}
								matches[k] = reqVal;
							}
						}
						if (!match) { continue; }

						Util.log('routing', ' > ',/*server.inst,*/route.cb,'MATCH');
						var cb = server.inst[route.cb];
						if (!cb) {
							Util.log('errors', "Handler callback '" + route.cb + "' not found in object");
							continue;
						}
						matched_handlers.push({
							cb:cb,
							context:server.inst,
							match:matches,
							capture:route.capture
						});
					}
				}
			}, this);
			return matched_handlers;
		}

		// (ASYNC) Builds the handler chain from the request, then runs
		//  - When finished, calls the given cb with the response
		//  - If the request target URI does not start with a hash, will run the remote handler
		HttpRouter.prototype.dispatch = function HttpRouter__dispatch(request, opt_cb, opt_context) {
			request = Util.deepCopy(request);
			Object.defineProperty(request, '__mid', { value:this.cur_mid++ })

			// URIs that dont target hash URIs should be fetched remotely
			if (request.uri.charAt(0) != '#') { 
				return __dispatchRemote.call(this, request);
			}

			Util.log('traffic', this.id ? this.id+'|req' : '|> ', request);

			__processQueryParams(request);

			var handlers = HttpRouter__findHandlers.call(this, request);        
			Object.defineProperty(request, '__bubble_handlers', { value:[], writable:true });
			Object.defineProperty(request, '__capture_handlers', { value:[], writable:true });
			for (var i=0; i < handlers.length; i++) {
				if (handlers[i].capture) {
					request.__capture_handlers.push(handlers[i]);
				} else {
					request.__bubble_handlers.push(handlers[i]);
				}
			}

			var dispatch_promise = new Promise();
			opt_cb && dispatch_promise.then(opt_cb, opt_context);
			this.response_cbs.forEach(function(cb) {
				dispatch_promise.then(cb.fn, cb.context);
			});
			Object.defineProperty(request, '__dispatch_promise', { value:dispatch_promise });

			var self = this;
			setTimeout(function() { HttpRouter__runHandlers.call(self, request); }, 0);
			return dispatch_promise;
		};

		function HttpRouter__runHandlers(request) {
			var handler = request.__capture_handlers.shift();
			if (!handler) { handler = request.__bubble_handlers.shift(); }
			if (!handler) { return HttpRouter__finishHandling.call(this, request, null); }

			var promise = handler.cb.call(handler.context, request, handler.match);
			Promise.when(promise, function(response) {
				if (response) {
					HttpRouter__finishHandling.call(this, request, response);
				} else {
					HttpRouter__runHandlers.call(this, request);
				}
			}, this);
		}

		function HttpRouter__finishHandling(request, response) {
			if (!response) { 
				response = HttpRouter.response(404, 'Not Found', 'text/plain');
			}
			Util.log('traffic', this.id ? this.id+'|res' : ' >|', response);

			response.org_request = request; // :TODO: if this isn't necessary, it should go
			response.body = ContentTypes.deserialize(response.body, response['content-type']);

			request.__dispatch_promise.fulfill(response);
		}

		// :TODO: remove when possible
		HttpRouter.prototype.addResponseListener = function HttpRouter__addResponseListener(fn, opt_context) {
			this.response_cbs.push({ fn:fn, context:opt_context });
		};
		HttpRouter.prototype.removeResponseListener = function HttpRouter__removeResponseListener(fn) {
			this.response_cbs.forEach(function(cb, i) {
				if (cb.fn == fn) {
					this.response_cbs.splice(i, 1);
				}
			}, this);
		};

		// Pulls the query params into the request.query object
		function __processQueryParams(request) {
			request.query = request.query || {};
			if (request.uri && request.uri.indexOf('?') != -1) {
				// pull uri out
				var parts = request.uri.split('?');
				request.uri = parts.shift();
				// iterate the values
				parts = parts.join('').split('&');
				for (var i=0; i < parts.length; i++) {
					var kv = parts[i].split('=');
                    var k = kv[0], v = kv[1];
                    if (v.charAt(0) == '"') { v = /"(.*)"/.exec(v)[1]; }
                    else if (v.charAt(0) == "'") { v = /'(.*)'/.exec(v)[1]; }
                    if (k in request.query) {
                        if (Array.isArray(request.query[k])) {
                            request.query[k].push(v);
                        } else {
                            request.query[k] = [v];
                        }
                    } else {
					    request.query[k] = v;
                    }
				}
			}
		}

		HttpRouter.prototype.ajaxConfig = function ajaxConfig(k, v) {
			if (typeof v == "undefined") { return this.ajax_config[k]; }
			this.ajax_config[k] = v;
			return v;
		};

		function __dispatchRemote(request) {
			if (typeof window != 'undefined') {
				__sendAjaxRequest.call(this, request);
			} else {
				request.__dispatch_promise.fulfill(HttpRouter.response(404, 'Not Found', 'text/plain'));
			}
		}
		function __sendAjaxRequest(request) {
			var xhrRequest = new XMLHttpRequest();
			var target_uri = request.uri;

			var query = '';
			if (request.query) {
				var q = [];
				for (var k in request.query) {
					q.push(k+'='+request.query[k]);
				}
				if (q.length) {
					query = '?' + q.join('&');
				}
			}

			if (this.ajax_config.proxy && /:\/\//.test(target_uri)) { // only use proxy if a protocol-qualified URL
				request[this.ajax_config.proxy_query_header] = query;
				target_uri = this.ajax_config.proxy + '?url=' + request.uri;
			} else {
				target_uri += query;
			}

			request.body = ContentTypes.serialize(request.body, request['content-type']);
			xhrRequest.open(request.method, target_uri, true);
			for (var k in request) {
				if (k == 'method' || k == 'uri' || k == 'body') { continue; }
				xhrRequest.setRequestHeader(k, request[k]);
			}

			xhrRequest.onreadystatechange = function() {
				if (xhrRequest.readyState == 4) {
					var response = {};
					// :NOTE: a bug in firefox causes getAllResponseHeaders to return an empty string on CORS
					// we either need to bug them, or iterate the headers we care about with getResponseHeader
					xhrRequest.getAllResponseHeaders().split("\n").forEach(function(h) {
						if (!h) { return; }
						var kv = h.toLowerCase().replace('\r','').split(': ');
						response[kv[0]] = kv[1];
					});

					response.code = xhrRequest.status;
					response.reason = xhrRequest.statusText;
					response.org_request = request; // :TODO: remove if possible
					response.body = ContentTypes.deserialize(xhrRequest.responseText, response['content-type']);

					Util.log('traffic', this.id ? this.id+'|res' : ' >|', response);
					request.__dispatch_promise.fulfill(response);
				}
			};
			xhrRequest.send(request.body);
		}

		HttpRouter.route = function HttpRouter__route(cb, match, capture_phase) {
			return { cb:cb, match:match, capture:capture_phase };
		};
		HttpRouter.response = function HttpRouter__response(code, body, contenttype, headers) {
			var response = headers || {};
            if (Array.isArray(code)) {
			    response.code = code[0];
                response.reason = code[1];
            } else {
                response.code = code;
            }
            if (body) { response.body = body; }
			if (contenttype) { response['content-type'] = contenttype; }
			return response;
		};	
	})();
}