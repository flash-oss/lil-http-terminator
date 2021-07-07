const assert = require("assert");
const http = require("http");
const delay = require("./delay");

module.exports = function HttpTerminator({ server, gracefulTerminationTimeout = 1000, logger = console }) {
    assert(server);

    const _sockets = new Set();
    const _secureSockets = new Set();

    let terminating;

    server.on("connection", socket => {
        if (terminating) {
            socket.destroy();
        } else {
            _sockets.add(socket);

            socket.once("close", () => {
                _sockets.delete(socket);
            });
        }
    });

    server.on("secureConnection", socket => {
        if (terminating) {
            socket.destroy();
        } else {
            _secureSockets.add(socket);

            socket.once("close", () => {
                _secureSockets.delete(socket);
            });
        }
    });

    /**
     * Evaluate whether additional steps are required to destroy the socket.
     *
     * @see https://github.com/nodejs/node/blob/57bd715d527aba8dae56b975056961b0e429e91e/lib/_http_client.js#L363-L413
     */
    function destroySocket(socket) {
        socket.destroy();

        if (socket.server instanceof http.Server) {
            _sockets.delete(socket);
        } else {
            _secureSockets.delete(socket);
        }
    }

    return {
        _secureSockets,
        _sockets,
        async terminate() {
            if (terminating) {
                logger.warn("lil-http-terminator: already terminating HTTP server");

                return terminating;
            }

            let resolveTerminating;
            let rejectTerminating;

            terminating = new Promise((resolve, reject) => {
                resolveTerminating = resolve;
                rejectTerminating = reject;
            });

            server.on("request", (incomingMessage, outgoingMessage) => {
                if (!outgoingMessage.headersSent) {
                    outgoingMessage.setHeader("connection", "close");
                }
            });

            for (const socket of _sockets) {
                // This is the HTTP CONNECT request socket.
                if (!(socket.server instanceof http.Server)) {
                    continue;
                }

                const serverResponse = socket._httpMessage;

                if (serverResponse) {
                    if (!serverResponse.headersSent) {
                        serverResponse.setHeader("connection", "close");
                    }

                    continue;
                }

                destroySocket(socket);
            }

            for (const socket of _secureSockets) {
                const serverResponse = socket._httpMessage;

                if (serverResponse) {
                    if (!serverResponse.headersSent) {
                        serverResponse.setHeader("connection", "close");
                    }

                    continue;
                }

                destroySocket(socket);
            }

            if (_sockets.size) {
                await delay(gracefulTerminationTimeout);

                for (const socket of _sockets) {
                    destroySocket(socket);
                }
            }

            if (_secureSockets.size) {
                await delay(gracefulTerminationTimeout);

                for (const socket of _secureSockets) {
                    destroySocket(socket);
                }
            }

            server.close(error => {
                if (error) {
                    rejectTerminating(error);
                } else {
                    resolveTerminating();
                }
            });

            return terminating;
        }
    };
};
