// .set() inserts modules into the module registry.

var l = new Loader;
var m = new Module({});
l.set("water", m);
assertEq(l.get("water"), m);

// .set() first argument is converted to a String.



