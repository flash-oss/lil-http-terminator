const KeepAliveHttpAgent = require("agentkeepalive");
const test = require("ava");
const delay = require("../../src/delay");
const safeGot = require("got");
const sinon = require("sinon");
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

    const spy = sinon.spy();

    const httpServer = await createHttpServer(() => {
        spy();
    });

    const terminator = HttpTerminator({
        gracefulTerminationTimeout: 150,
        server: httpServer.server
    });

    got(httpServer.url);

    await delay(50);

    t.true(spy.called);

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

    const stub = sinon.stub();

    stub.onCall(0).callsFake((incomingMessage, outgoingMessage) => {
        outgoingMessage.write("foo");

        setTimeout(() => {
            outgoingMessage.end("bar");
        }, 50);
    });

    stub.onCall(1).callsFake((incomingMessage, outgoingMessage) => {
        // @todo Unable to intercept the response without the delay.
        // When `end()` is called immediately, the `request` event
        // already has `headersSent=true`. It is unclear how to intercept
        // the response beforehand.
        setTimeout(() => {
            outgoingMessage.end("baz");
        }, 50);
    });

    const httpServer = await createHttpServer(stub);

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

    await delay(50);

    t.is(stub.callCount, 2);

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
