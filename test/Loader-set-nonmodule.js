// .set() second argument must be a Module instance.

load(libdir + "asserts.js");

var nonmodules = [
    {},
    [],
    null,
    undefined,
    "H2O",
    Object.create(null)
];

var l = new Loader;
for (var v of nonmodules)
    assertThrowsInstanceOf(_ => l.set("water", v), TypeError);
