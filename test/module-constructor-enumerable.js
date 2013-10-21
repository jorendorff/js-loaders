// new Module(obj) only examines enumerable properties of obj.

var obj = {};
Object.defineProperty(obj, "a", {enumerable: false, value: 1});
Object.defineProperty(obj, "b", {
    configurable: true,
    enumerable: false,
    get: function () { return 2; },
    set: function (_) {}
});
var m = new Module(obj);
assertEq("a" in m, false);
