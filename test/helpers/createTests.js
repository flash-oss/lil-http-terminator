const assert = require("assert");
const KeepAliveHttpAgent = require("agentkeepalive");
const delay = require("../../src/delay");
const safeGot = require("got");
const createHttpTerminator = require("../../src");

const got = safeGot.extend({
    https: {
        rejectUnauthorized: false
    }
});

const KeepAliveHttpsAgent = KeepAliveHttpAgent.HttpsAgent;

module.exports = function(createHttpServer) {
    it("terminates HTTP server with no connections", async function() {
        const httpServer = await createHttpServer(() => {});

        this.timeout(1000);

        assert.strictEqual(true, httpServer.server.listening);

        const terminator = createHttpTerminator({
            server: httpServer.server
        });

        await terminator.terminate();

        assert.notStrictEqual(httpServer.server.listening, true);
    });

    it("terminates hanging sockets after gracefulTerminationTimeout", async function() {
        let serverCreated = false;

        const httpServer = await createHttpServer(() => {
            serverCreated = true;
        });

        this.timeout(500);

        const terminator = createHttpTerminator({
            gracefulTerminationTimeout: 150,
            server: httpServer.server
        });

        got(httpServer.url);

        await delay(50);

        assert.strictEqual(true, serverCreated);

        terminator.terminate();

        await delay(100);

        // The timeout has not passed.
        assert.strictEqual(await httpServer.getConnections(), 1);

        await delay(100);

        assert.strictEqual(await httpServer.getConnections(), 0);
    });

    it("server stops accepting new connections after terminator.terminate() is called", async function() {
        let callCount = 0;

        function requestHandler(incomingMessage, outgoingMessage) {
            if (callCount === 0) {
                setTimeout(() => {
                    outgoingMessage.end("foo");
                }, 100);
            } else if (callCount === 1) {
                outgoingMessage.end("bar");
            }
            callCount += 1;
        }

        const httpServer = await createHttpServer(requestHandler);

        this.timeout(500);

        const terminator = createHttpTerminator({
            gracefulTerminationTimeout: 150,
            server: httpServer.server
        });

        const request0 = got(httpServer.url);

        await delay(50);

        terminator.terminate();

        await delay(50);

        const request1 = got(httpServer.url, {
            retry: 0,
            timeout: {
                connect: 50
            }
        });

        // @todo https://stackoverflow.com/q/59832897/368691
        await assert.rejects(request1);

        const response0 = await request0;

        assert.strictEqual(response0.headers.connection, "close");
        assert.strictEqual(response0.body, "foo");
    });

    it("ongoing requests receive {connection: close} header", async function() {
        const httpServer = await createHttpServer((incomingMessage, outgoingMessage) => {
            setTimeout(() => {
                outgoingMessage.end("foo");
            }, 100);
        });

        this.timeout(600);

        const terminator = createHttpTerminator({
            gracefulTerminationTimeout: 150,
            server: httpServer.server
        });

        const httpAgent = new KeepAliveHttpAgent({
            maxSockets: 1
        });

        const httpsAgent = new KeepAliveHttpsAgent({
            maxSockets: 1
        });

        const request = got(httpServer.url, {
            agent: {
                http: httpAgent,
                https: httpsAgent
            }
        });

        await delay(50);

        terminator.terminate();

        const response = await request;

        assert.strictEqual(response.headers.connection, "close");
        assert.strictEqual(response.body, "foo");
    });

    it("ongoing requests receive {connection: close} header (new request reusing an existing socket)", async function() {
        let callCount = 0;

        function requestHandler(incomingMessage, outgoingMessage) {
            if (callCount === 0) {
                outgoingMessage.write("foo");

                setTimeout(() => {
                    outgoingMessage.end("bar");
                }, 51);
            } else if (callCount === 1) {
                // @todo Unable to intercept the response without the delay.
                // When `end()` is called immediately, the `request` event
                // already has `headersSent=true`. It is unclear how to intercept
                // the response beforehand.
                setTimeout(() => {
                    outgoingMessage.end("baz");
                }, 51);
            }
            callCount += 1;
        }

        const httpServer = await createHttpServer(requestHandler);

        this.timeout(1000);

        const terminator = createHttpTerminator({
            gracefulTerminationTimeout: 150,
            server: httpServer.server
        });

        const httpAgent = new KeepAliveHttpAgent({
            maxSockets: 1
        });

        const httpsAgent = new KeepAliveHttpsAgent({
            maxSockets: 1
        });

        const request0 = got(httpServer.url, {
            agent: {
                http: httpAgent,
                https: httpsAgent
            }
        });

        await delay(50);

        terminator.terminate();

        const request1 = got(httpServer.url, {
            agent: {
                http: httpAgent,
                https: httpsAgent
            },
            retry: 0
        });

        await delay(75);

        assert.strictEqual(callCount, 2);

        const response0 = await request0;

        assert.strictEqual(response0.headers.connection, "keep-alive");
        assert.strictEqual(response0.body, "foobar");

        const response1 = await request1;

        assert.strictEqual(response1.headers.connection, "close");
        assert.strictEqual(response1.body, "baz");
    });

    it("does not send {connection: close} when server is not terminating", async function() {
        const httpServer = await createHttpServer((incomingMessage, outgoingMessage) => {
            setTimeout(() => {
                outgoingMessage.end("foo");
            }, 50);
        });

        this.timeout(1000);

        createHttpTerminator({
            server: httpServer.server
        });

        const httpAgent = new KeepAliveHttpAgent({
            maxSockets: 1
        });

        const httpsAgent = new KeepAliveHttpsAgent({
            maxSockets: 1
        });

        const response = await got(httpServer.url, {
            agent: {
                http: httpAgent,
                https: httpsAgent
            }
        });

        assert.strictEqual(response.headers.connection, "keep-alive");
    });
};
