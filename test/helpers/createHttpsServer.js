const { createServer } = require("https");
const { promisify } = require("util");
const pem = require("pem");

module.exports = async (requestHandler) => {
    const { serviceKey, certificate, csr } = await promisify(pem.createCertificate)({
        days: 365,
        selfSigned: true,
    });

    const httpsOptions = {
        ca: csr,
        cert: certificate,
        key: serviceKey,
    };

    const server = createServer(httpsOptions, requestHandler);

    let serverShutingDown;

    const stop = () => {
        if (serverShutingDown) {
            return serverShutingDown;
        }

        serverShutingDown = promisify(server.close.bind(server))();

        return serverShutingDown;
    };

    const getConnections = () => {
        return promisify(server.getConnections.bind(server))();
    };

    return new Promise((resolve, reject) => {
        server.once("error", reject);

        server.listen(() => {
            const port = server.address().port;
            const url = "https://localhost:" + port;

            resolve({
                getConnections,
                port,
                server,
                stop,
                url,
            });
        });
    });
};
