load(libdir + "asserts.js");

assertEq(typeof Module, "function");
assertEq(Module.length, 1);

var desc = Object.getOwnPropertyDescriptor(this, "Module");
assertDeepEq(desc, {
    configurable: true,
    enumerable: false,
    value: Module,
    writable: true
});
