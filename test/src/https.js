const createHttpsServer = require("../helpers/createHttpsServer");
const createTests = require("../helpers/createTests");

describe("https", () => {
    createTests(createHttpsServer);
});
