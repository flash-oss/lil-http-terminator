const { createServer } = require("http");
const { promisify } = require("util");

module.exports = requestHandler => {
    const server = createServer(requestHandler);

    let serverShuttingDown;

    const stop = () => {
        if (serverShuttingDown) {
            return serverShuttingDown;
        }

        serverShuttingDown = promisify(server.close.bind(server))();

        return serverShuttingDown;
    };

    const getConnections = () => {
        return promisify(server.getConnections.bind(server))();
    };

    return new Promise((resolve, reject) => {
        server.once("error", reject);

        server.listen(() => {
            const port = server.address().port;
            const url = "http://localhost:" + port;

            resolve({
                getConnections,
                port,
                server,
                stop,
                url
            });
        });
    });
};
