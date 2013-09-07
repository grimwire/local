// WebRTC Peer Server
// ==================

(function() {

	var peerConstraints = {
		optional: [{ RtpDataChannels: true }]
	};
	var mediaConstraints = {
		optional: [],
		mandatory: { OfferToReceiveAudio: false, OfferToReceiveVideo: false }
	};
	var defaultIceServers = { iceServers: [{ url: 'stun:stun.l.google.com:19302' }] };

	// RTCPeerServer
	// =============
	// EXPORTED
	// server wrapper for WebRTC connections
	// - currently only supports Chrome
	// - `config.peer`: required object, who we are connecting to (should be supplied by the peer relay)
	//   - `config.peer.user`: required string, the peer's user ID
	//   - `config.peer.app`: required string, the peer's app domain
	// - `config.relay`: required PeerWebRelay
	// - `config.initiate`: optional bool, if true will initiate the connection processes
	// - `config.serverFn`: optional function, the handleRemoteWebRequest function
	function RTCPeerServer(config) {
		// Config
		var self = this;
		if (!config) config = {};
		if (!config.peer) throw new Error("`config.peer` is required");
		if (typeof config.peer.user == 'undefined') throw new Error("`config.peer.user` is required");
		if (typeof config.peer.app == 'undefined') throw new Error("`config.peer.app` is required");
		if (!config.relay) throw new Error("`config.relay` is required");
		local.web.BridgeServer.call(this, config);
		local.util.mixinEventEmitter(this);
		if (config.serverFn) {
			this.handleRemoteWebRequest = config.serverFn;
		}

		// Internal state
		this.isOfferExchanged = false;
		this.isConnected = false;
		this.candidateQueue = []; // cant add candidates till we get the offer
		this.signalBacklog = []; // holds signal messages that have backed up due to an unavailable remote
		this.retrySignalTimeout = null;

		// Create the peer connection and HTTPL data channel
		var servers = config.iceServers || defaultIceServers;
		this.peerConn = new webkitRTCPeerConnection(servers, peerConstraints);
		this.httplChannel = this.peerConn.createDataChannel('httpl', { ordered: true, reliable: true });
		this.peerConn.onicecandidate = onIceCandidate.bind(this);
		this.httplChannel.onopen     = onHttplChannelOpen.bind(this);
		this.httplChannel.onclose    = onHttplChannelClose.bind(this);
		this.httplChannel.onerror    = onHttplChannelError.bind(this);
		this.httplChannel.onmessage  = onHttplChannelMessage.bind(this);

		if (this.config.initiate) {
			// Initiate event will be picked up by the peer
			// If they want to connect, they'll send an answer back
			this.sendOffer();
		}
	}
	RTCPeerServer.prototype = Object.create(local.web.BridgeServer.prototype);
	local.web.RTCPeerServer = RTCPeerServer;

	// :DEBUG:
	RTCPeerServer.prototype.debugLog = function() {
		var args = [this.config.domain].concat([].slice.call(arguments));
		console.debug.apply(console, args);
	};

	RTCPeerServer.prototype.terminate = function(ops) {
		if (this.isConnected) {
			this.isConnected = false;
			if (!(opts && opts.noSignal)) {
				this.signal({ type: 'disconnect' });
			}
			var config = this.config;
			this.emit('disconnected', { user: config.peer.user, app: config.peer.app, domain: config.domain, server: this });

			if (this.peerConn) {
				this.peerConn.close();
				this.peerConn = null;
			}
		}
	};

	// Returns true if the channel is ready for activity
	// - returns boolean
	RTCPeerServer.prototype.isChannelActive = function() {
		return this.isConnected;
	};

	// Sends a single message across the channel
	// - `msg`: required string
	RTCPeerServer.prototype.channelSendMsg = function(msg) {
		this.httplChannel.send(msg);
	};

	// Remote request handler
	RTCPeerServer.prototype.handleRemoteWebRequest = function(request, response) {
		response.writeHead(500, 'not implemented');
		response.end();
	};

	// HTTPL channel event handlers
	// -

	function onHttplChannelMessage(msg) {
		this.debugLog('HTTPL CHANNEL MSG', msg);

		// Pass on to method in parent prototype
		this.onChannelMessage(msg.data);
	}

	function onHttplChannelOpen(e) {
		this.debugLog('HTTPL CHANNEL OPEN', e);

		// Update state
		this.isConnected = true;
		this.flushBufferedMessages();

		// Emit event
		var config = this.config;
		this.emit('connected', { user: config.peer.user, app: config.peer.app, domain: config.domain, server: this });
	}

	function onHttplChannelClose(e) {
		this.debugLog('HTTPL CHANNEL CLOSE', e);

		if (this.isConnected) {
			// Emit event to warn that this happened - may not have been on purpose
			// var config = this.config;
			// this.emit('drop', { user: config.peer.user, app: config.peer.app, domain: config.domain });
			// :TODO: smart autoreconnect behavior, I'm thinking
		}

		// Update state
		this.isConnected = false;
	}

	function onHttplChannelError(e) {
		// :TODO: anything?
		this.debugLog('HTTPL CHANNEL ERR', e);
		var config = this.config;
		this.emit('error', { user: config.peer.user, app: config.peer.app, domain: config.domain, server: this, err: e });
	}

	// Signal relay behaviors
	// -

	RTCPeerServer.prototype.onSignal = function(msg) {
		var self = this;

		this.debugLog('SIG', msg);
		switch (msg.type) {
			case 'disconnect':
				// Peer's dead, shut it down
				this.terminate({ noSignal: true });
				break;

			case 'candidate':
				this.debugLog('GOT CANDIDATE', msg.candidate);
				// Received address info from the peer
				if (!this.isOfferExchanged) {
					// Store for when offer/answer exchange has finished
					this.candidateQueue.push(msg.candidate);
				} else {
					// Pass into the peer connection
					this.peerConn.addIceCandidate(new RTCIceCandidate({ candidate: msg.candidate }));
				}
				break;

			case 'offer':
				this.debugLog('GOT OFFER', msg);
				// Received a session offer from the peer
				// Update the peer connection
				var desc = new RTCSessionDescription({ type: 'offer', sdp: msg.sdp });
				this.peerConn.setRemoteDescription(desc);
				// Burn the ICE candidate queue
				handleOfferExchanged.call(self);
				// Send an answer
				this.peerConn.createAnswer(
					function(desc) {
						self.debugLog('CREATED ANSWER', desc);

						// Store the SDP
						desc.sdp = increaseSDP_MTU(desc.sdp);
						self.peerConn.setLocalDescription(desc);

						// Send answer msg
						self.signal({ type: 'answer', sdp: desc.sdp });
					},
					null,
					mediaConstraints
				);
				break;

			case 'answer':
				this.debugLog('GOT ANSWER', msg);
				// Received session confirmation from the peer
				// Update the peer connection
				this.peerConn.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
				// Burn the ICE candidate queue
				handleOfferExchanged.call(self);
				break;

			default:
				console.warn('RTCPeerServer - Unrecognized signal message from relay', msg);
		}
	};

	// Helper to send a message to peers on the relay
	RTCPeerServer.prototype.signal = function(msg) {
		// Are there signal messages awaiting delivery?
		if (this.retrySignalTimeout) {
			// Add to the queue and wait for the line to open up again
			this.signalBacklog.push(msg);
			return;
		}
		// Send the message through our relay
		var self = this;
		this.config.relay.signal(this.config.peer, msg)
			.fail(function(res) {
				if (res.status == 504) {
					// Upstream timeout -- the target isn't online yet, start the queue and initiate the retry process
					self.signalBacklog.push(msg);
					if (!self.retrySignalTimeout) {
						self.retrySignalTimeout = setTimeout(self.retrySignal.bind(self), 500);
					}
				}
			});
	};

	// Helper to send a message to peers on the relay
	RTCPeerServer.prototype.retrySignal = function(msg) {
		this.retrySignalTimeout = null;
		// Are there signal messages awaiting delivery?
		if (this.signalBacklog.length === 0) {
			// Nothing to do
			return;
		}
		// Retry the first message
		var self = this;
		this.config.relay.signal(this.config.peer, this.signalBacklog[0])
			.then(function() {
				// Success, drain the queue
				var signalBacklog = self.signalBacklog;
				self.signalBacklog = [];
				for (var i = 1; i < signalBacklog.length; i++) {
					self.signal(signalBacklog[i]);
				}
			})
			.fail(function(res) {
				if (res.status == 504) {
					// Retry again later
					if (!self.retrySignalTimeout) {
						self.retrySignalTimeout = setTimeout(self.retrySignal.bind(self), 500);
					}
				}
			});
	};

	// Helper initiates a session with peers on the relay
	RTCPeerServer.prototype.sendOffer = function() {
		var self = this;
		// Generate offer
		this.peerConn.createOffer(
			function(desc) {
				self.debugLog('CREATED OFFER', desc);

				// store the SDP
				desc.sdp = increaseSDP_MTU(desc.sdp);
				self.peerConn.setLocalDescription(desc);

				// Send offer msg
				self.signal({ type: 'offer', sdp: desc.sdp });
			},
			null,
			mediaConstraints
		);
	};

	// Helper called whenever we have a remote session description
	// (candidates cant be added before then, so they're queued in case they come first)
	function handleOfferExchanged() {
		var self = this;
		this.isOfferExchanged = true;
		this.candidateQueue.forEach(function(candidate) {
			self.peerConn.addIceCandidate(new RTCIceCandidate({ candidate: candidate }));
		});
		this.candidateQueue.length = 0;
	}

	// Called by the RTCPeerConnection when we get a possible connection path
	function onIceCandidate(e) {
		if (e && e.candidate) {
			this.debugLog('FOUND ICE CANDIDATE', e.candidate);
			// send connection info to peers on the relay
			this.signal({ type: 'candidate', candidate: e.candidate.candidate });
		}
	}

	// Increases the bandwidth allocated to our connection
	// Thanks to michellebu (https://github.com/michellebu/reliable)
	var higherBandwidthSDPRE = /b\=AS\:([\d]+)/i;
	function increaseSDP_MTU(sdp) {
		return sdp.replace(higherBandwidthSDPRE, 'b=AS:102400'); // 100 Mbps
	}


	// PeerWebRelay
	// ============
	// EXPORTED
	// Helper class for managing a peer web relay provider
	// - `config.provider`: required string, the relay provider
	// - `config.serverFn`: required function, the function for peerservers' handleRemoteWebRequest
	// - `config.app`: optional string, the app to join as (defaults to window.location.host)
	function PeerWebRelay(config) {
		if (!config) throw new Error("PeerWebRelay requires the `config` parameter");
		if (!config.provider) throw new Error("PeerWebRelay requires `config.provider`");
		if (!config.serverFn) throw new Error("PeerWebRelay requires `config.serverFn`");
		if (!config.app) config.app = window.location.host;
		this.config = config;
		local.util.mixinEventEmitter(this);

		// Extract provider domain
		var providerUrld = local.web.parseUri(config.provider);
		this.providerDomain = providerUrld.authority.replace(/\:/g, '.');

		// State
		this.onMessageFromPopup = null;
		this.userId = null;
		this.accessToken = null;
		this.srcObj = null; // used in outbound signal messages
		this.bridges = [];

		// APIs
		this.p2pwServiceAPI = local.navigator(config.provider);
		this.accessTokenAPI = this.p2pwServiceAPI.follow({ rel: 'grimwire.com/-access-token', app: config.app }); // :BREAK:
		this.p2pwRelayAPI = null;
		this.relayStream = null;

		// Event-handlers
		this.on('accessGranted', this.onAccessGranted.bind(this));
	}
	local.web.PeerWebRelay = PeerWebRelay;

	// Sets the access token and triggers a connect flow
	// - `token`: required String?, the access token (null if denied access)
	// - `token` should follow the form '<userId>:<'
	PeerWebRelay.prototype.setAccessToken = function(token) {
		if (token) {
			// Extract user-id from the access token
			var tokenParts = token.split(':');
			if (tokenParts.length !== 2) {
				throw new Error('Invalid access token');
			}

			// Store
			this.userId = tokenParts[0];
			this.accessToken = token;
			this.srcObj = { user: this.getUserId(), app: this.config.app };
			this.p2pwServiceAPI.setRequestDefaults({ headers: { authorization: 'Bearer '+token }});

			// Emit an event
			this.emit('accessGranted');
		} else {
			// Update state and emit event
			this.userId = null;
			this.accessToken = null;
			this.emit('accessDenied');
		}
	};
	PeerWebRelay.prototype.getUserId = function() {
		return this.userId;
	};
	PeerWebRelay.prototype.getAccessToken = function() {
		return this.accessToken;
	};

	// Gets an access token from the provider & user using a popup
	// - Best if called within a DOM click handler, as that will avoid popup-blocking
	PeerWebRelay.prototype.requestAccessToken = function() {
		// Start listening for messages from the popup
		if (!this.onMessageFromPopup) {
			this.onMessageFromPopup = (function(e) {
				console.debug('Message (from ' + e.origin + '): ' + e.data);

				// Make sure this is from our popup
				if (e.origin !== this.config.provider) {
					return;
				}

				// Update our token
				this.setAccessToken(e.data);

				// Stop listening
				window.removeEventListener('message', this.onMessageFromPopup);
			}).bind(this);
			window.addEventListener('message', this.onMessageFromPopup);
		}

		// Resolve the URL for getting access tokens
		this.accessTokenAPI.resolve({ nohead: true }).then(function(url) {
			// Open interface in a popup
			window.open(url);
		});
	};

	// Spawns an RTCPeerServer and starts the connection process with the given peer
	// - `user`: required String, the id of the target user
	// - `config.app`: optional String, the app of the peer to connect to
	//   - defaults to window.location.host
	// - `config.initiate`: optional Boolean, should the server initiate the connection?
	//   - defaults to true
	//   - should only be false if the connection was already initiated by the opposite end
	PeerWebRelay.prototype.connect = function(user, config) {
		if (!config) config = {};
		if (!config.app) config.app = window.location.host;
		if (typeof config.initiate == 'undefined') config.initiate = true;

		// Spawn new server
		var server = new local.web.RTCPeerServer({
			peer: { user: user, app: config.app },
			initiate: config.initiate,
			relay: this,
			serverFn: this.config.serverFn
		});

		// Bind events
		server.on('connected', this.emit.bind(this, 'connected'));
		server.on('disconnected', this.onBridgeDisconnected.bind(this));
		server.on('disconnected', this.emit.bind(this, 'disconnected'));
		server.on('error', this.emit.bind(this, 'error'));

		// Add to hostmap
		var domain = this.makeDomain(config.app, user, this.providerDomain);
		this.bridges[domain] = server;
		local.web.registerLocal(domain, server);
		return server;
	};

	//
	PeerWebRelay.prototype.onAccessGranted = function() {
		var self = this;
		// Connect to the relay stream
		this.p2pwRelayAPI = this.p2pwServiceAPI.follow({ rel: 'item grimwire.com/-p2pw/relay', id: this.getUserId() });
		this.p2pwRelayAPI.subscribe()
			.then(function(stream) {
				self.relayStream = stream;
				stream.on('signal', self.onSignal.bind(self));
			}, function(err) {
				console.warn('Failed to establish p2pw relay stream');
				self.emit('error', { err: err });
			});
	};

	PeerWebRelay.prototype.signal = function(dst, msg) {
		if (!this.p2pwRelayAPI) {
			console.warn('PeerWebRelay - signal() called before relay is connected');
			return;
		}
		return this.p2pwRelayAPI.post({ src: this.srcObj, dst: dst, msg: msg });
	};

	PeerWebRelay.prototype.onSignal = function(e) {
		if (!e.data || !e.data.src || !e.data.msg) {
			console.warn('discarding faulty signal message', err);
		}

		// Find bridge that represents this origin
		var src = e.data.src;
		var domain = this.makeDomain(src.app, src.user, this.providerDomain);
		var bridgeServer = this.bridges[domain];

		// Does bridge exist?
		if (bridgeServer) {
			// Let bridge handle it
			bridgeServer.onSignal(e.data.msg);
		} else {
			// Create a server to handle the signal
			bridgeServer = this.connect(src.user, { app: src.app, initiate: false });
			bridgeServer.onSignal(e.data.msg);
		}
	};

	PeerWebRelay.prototype.onBridgeDisconnected = function(e) {
		// Stop tracking bridges that close
		var bridge = this.bridges[e.data.domain];
		if (bridge) {
			delete this.bridges[e.data.domain];
			local.web.unregisterLocal(e.data.domain);
		}
	};

	PeerWebRelay.prototype.makeDomain = function(app, user, provider) {
		return app+'_.'+user+'_.'+provider;
	};

})();