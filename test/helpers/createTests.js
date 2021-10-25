const KeepAliveHttpAgent = require("agentkeepalive");
const test = require("ava");
const delay = require("../../src/delay");
const safeGot = require("got");
const createHttpTerminator = require("../../src");

const got = safeGot.extend({
    https: {
        rejectUnauthorized: false
    }
});

const KeepAliveHttpsAgent = KeepAliveHttpAgent.HttpsAgent;

module.exports = createHttpServer => {
    test("terminates HTTP server with no connections", async t => {
        const httpServer = await createHttpServer(() => {});

        t.timeout(100);

        t.true(httpServer.server.listening);

        const terminator = createHttpTerminator({
            server: httpServer.server
        });

        await terminator.terminate();

        t.false(httpServer.server.listening);
    });

    test("terminates hanging sockets after gracefulTerminationTimeout", async t => {
        let serverCreated = false;

        const httpServer = await createHttpServer(() => {
            serverCreated = true;
        });

        t.timeout(500);

        const terminator = createHttpTerminator({
            gracefulTerminationTimeout: 150,
            server: httpServer.server
        });

        got(httpServer.url);

        await delay(50);

        t.true(serverCreated);

        terminator.terminate();

        await delay(100);

        // The timeout has not passed.
        t.is(await httpServer.getConnections(), 1);

        await delay(100);

        t.is(await httpServer.getConnections(), 0);
    });

    test("server stops accepting new connections after terminator.terminate() is called", async t => {
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

        t.timeout(500);

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
        await t.throwsAsync(request1);

        const response0 = await request0;

        t.is(response0.headers.connection, "close");
        t.is(response0.body, "foo");
    });

    test("ongoing requests receive {connection: close} header", async t => {
        const httpServer = await createHttpServer((incomingMessage, outgoingMessage) => {
            setTimeout(() => {
                outgoingMessage.end("foo");
            }, 100);
        });

        t.timeout(600);

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

        t.is(response.headers.connection, "close");
        t.is(response.body, "foo");
    });

    test("ongoing requests receive {connection: close} header (new request reusing an existing socket)", async t => {
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

        t.timeout(1000);

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

        t.is(callCount, 2);

        const response0 = await request0;

        t.is(response0.headers.connection, "keep-alive");
        t.is(response0.body, "foobar");

        const response1 = await request1;

        t.is(response1.headers.connection, "close");
        t.is(response1.body, "baz");
    });

    test("does not send {connection: close} when server is not terminating", async t => {
        const httpServer = await createHttpServer((incomingMessage, outgoingMessage) => {
            setTimeout(() => {
                outgoingMessage.end("foo");
            }, 50);
        });

        t.timeout(100);

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

        t.is(response.headers.connection, "keep-alive");
    });
};
