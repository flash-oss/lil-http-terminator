const KeepAliveHttpAgent = require("agentkeepalive");
const test = require("ava");
const delay = require("../../src/delay");
const safeGot = require("got");
const HttpTerminator = require("../../src");
const createHttpServer = require("../helpers/createHttpServer");
const createHttpsServer = require("../helpers/createHttpsServer");

const got = safeGot.extend({
    https: {
        rejectUnauthorized: false
    }
});

test("terminates HTTP server with no connections", async t => {
    t.timeout(100);

    const httpServer = await createHttpServer(() => {});

    t.true(httpServer.server.listening);

    const terminator = HttpTerminator({
        server: httpServer.server
    });

    const result = await terminator.terminate();

    t.false(httpServer.server.listening);
    t.true(result.success);
    t.is(result.code, "TERMINATED");
});

test("terminates hanging sockets after httpResponseTimeout", async t => {
    t.timeout(500);

    let serverCreated = false;

    const httpServer = await createHttpServer(() => {
        serverCreated = true;
    });

    const terminator = HttpTerminator({
        gracefulTerminationTimeout: 150,
        server: httpServer.server
    });

    got(httpServer.url);

    await delay(50);

    t.true(serverCreated);

    const terminationPromise = terminator.terminate();

    await delay(100);

    // The timeout has not passed.
    t.is(await httpServer.getConnections(), 1);

    await delay(100);

    t.is(await httpServer.getConnections(), 0);

    const result = await terminationPromise;

    t.true(result.success);
});

test("server stops accepting new connections after terminator.terminate() is called", async t => {
    t.timeout(500);

    const httpServer = await createHttpServer((incomingMessage, outgoingMessage) => {
        setTimeout(() => {
            outgoingMessage.end("foo");
        }, 100);
    });

    const terminator = HttpTerminator({
        gracefulTerminationTimeout: 150,
        server: httpServer.server
    });

    const request0 = got(httpServer.url);

    await delay(50);

    const terminationPromise = terminator.terminate();

    await delay(50);

    const request1 = got(httpServer.url, {
        retry: 0,
        timeout: {
            connect: 50
        }
    });

    await t.throwsAsync(request1);

    const response0 = await request0;

    t.is(response0.headers.connection, "close");
    t.is(response0.body, "foo");

    const result = await terminationPromise;

    t.true(result.success);
});

test("ongoing requests receive {connection: close} header", async t => {
    t.timeout(500);

    const httpServer = await createHttpServer((incomingMessage, outgoingMessage) => {
        setTimeout(() => {
            outgoingMessage.end("foo");
        }, 100);
    });

    const terminator = HttpTerminator({
        gracefulTerminationTimeout: 150,
        server: httpServer.server
    });

    const request = got(httpServer.url, {
        agent: {
            http: new KeepAliveHttpAgent()
        }
    });

    await delay(50);

    const terminationPromise = terminator.terminate();

    const response = await request;

    t.is(response.headers.connection, "close");
    t.is(response.body, "foo");

    const result = await terminationPromise;

    t.true(result.success);
});

test("ongoing requests receive {connection: close} header (new request reusing an existing socket)", async t => {
    t.timeout(1000);

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

    const terminator = HttpTerminator({
        gracefulTerminationTimeout: 150,
        server: httpServer.server
    });

    const agent = new KeepAliveHttpAgent({
        maxSockets: 1
    });

    const request0 = got(httpServer.url, {
        agent: {
            http: agent
        }
    });

    await delay(50);

    const terminationPromise = terminator.terminate();

    const request1 = got(httpServer.url, {
        agent: {
            http: agent
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

    const result = await terminationPromise;

    t.true(result.success);
});

test("empties internal socket collection", async t => {
    t.timeout(500);

    const httpServer = await createHttpServer((incomingMessage, outgoingMessage) => {
        outgoingMessage.end("foo");
    });

    const terminator = HttpTerminator({
        gracefulTerminationTimeout: 150,
        server: httpServer.server
    });

    await got(httpServer.url);

    await delay(50);

    t.is(terminator._sockets.size, 0);
    t.is(terminator._secureSockets.size, 0);

    const result = await terminator.terminate();

    t.true(result.success);
});

test("empties internal socket collection for https server", async t => {
    t.timeout(500);

    const httpsServer = await createHttpsServer((incomingMessage, outgoingMessage) => {
        outgoingMessage.end("foo");
    });

    const terminator = HttpTerminator({
        gracefulTerminationTimeout: 150,
        server: httpsServer.server
    });

    await got(httpsServer.url);

    await delay(50);

    t.is(terminator._secureSockets.size, 0);

    const result = await terminator.terminate();

    t.true(result.success);
});

test("returns {success: false, code: 'TIMED_OUT'} if server couldn't close in time", async t => {
    t.timeout(500);

    const terminator = HttpTerminator({
        gracefulTerminationTimeout: 100,
        maxWaitTimeout: 300,
        server: {
            on: () => {},
            close: cb => setTimeout(cb, 400)
        }
    });

    const result = await terminator.terminate();

    t.false(result.success);
    t.is(result.code, "TIMED_OUT");
});

test("returns {success: false, code: 'SERVER_ERROR'} if server closing gives error", async t => {
    t.timeout(500);

    const terminator = HttpTerminator({
        gracefulTerminationTimeout: 10,
        logger: { warn: () => {} },
        server: {
            on: () => {},
            close: cb => setTimeout(() => cb(new Error("Can't close socket for some reason")), 400)
        }
    });

    const result = await terminator.terminate();

    t.false(result.success);
    t.is(result.code, "SERVER_ERROR");
});

test("returns {success: false, code: 'INTERNAL_ERROR'} if unexpected exception", async t => {
    t.timeout(500);

    const terminator = HttpTerminator({
        gracefulTerminationTimeout: 10,
        logger: { warn: () => {} },
        server: {
            on: () => {},
            close: () => {
                throw new Error("Unexpected");
            }
        }
    });

    const result = await terminator.terminate();

    t.false(result.success);
    t.is(result.code, "INTERNAL_ERROR");
});

test("closes immediately after in-flight connections are closed", async t => {
    t.timeout(1000);

    function requestHandler(incomingMessage, outgoingMessage) {
        setTimeout(() => {
            outgoingMessage.end("foo");
        }, 100);
    }

    const httpServer = await createHttpServer(requestHandler);

    t.true(httpServer.server.listening);

    const terminator = HttpTerminator({
        gracefulTerminationTimeout: 500,
        server: httpServer.server
    });

    got(httpServer.url);

    await delay(50);

    t.is(await httpServer.getConnections(), 1);

    terminator.terminate();

    // Wait for outgoingMessage.end to be called, plus a few extra ms for the
    // terminator to finish polling in-flight connections. (Do not, however, wait
    // long enough to trigger graceful termination.)
    await delay(75);

    t.is(await httpServer.getConnections(), 0);
});
