const createHttpServer = require("../helpers/createHttpServer");
const createTests = require("../helpers/createTests");

describe("http", () => {
    createTests(createHttpServer);
});
