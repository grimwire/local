var router = local.http.ext.router;
var responder = local.http.ext.responder;
function main(request, response) {
	router(request).mpa('get', '/', /html/, function() {
		responder(response).ok('html').end([
			'<h1>Local <small>0.3.0dev</small></h1>',
			'<p>Run user applications on the page using Web Workers.</p>',
			'<h4>Introduction</h4>',
			'<p>Local is an HTTP abstraction over the Web Worker \'postMessage\' API. It allows local servers to run in browser threads, where they host HTML and act as proxies to remote services. Because the servers are unable to access the document\'s namespace, execute inline scripts (due to CSP) or break the message routing policies of the host document, they can be used as containers for untrusted software.',
			'<blockquote><small>Click the script icons on the top right of this page\'s apps to view and modify their source.</small></blockquote>'
		].join(''));
	}).error(response);
}