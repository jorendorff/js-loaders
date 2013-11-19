// Returning a trivial factory object from the instantiate hook.

var m = new Module({x: 1});
var l = new Loader({
    fetch: function (address) {
        return "";
    },
    instantiate: function (source) {
        return {deps: [], execute: () => m};
    }
});
l.import("water").then(x => {
    assertEq(x, m);
    assertEq(l.get("water"), m);
    return l.load("flowers");
}).then(x => {
    assertEq(x, undefined);
    assertEq(l.get("flowers"), m);
    test.pass();
}).catch(test.fail);

test.run();
