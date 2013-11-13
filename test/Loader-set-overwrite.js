// .set() can overwrite previously inserted modules.

var l = new Loader;
var m1 = new Module({}), m2 = new Module({});
l.set("water", m1);
l.set("water", m2);
assertEq(l.get("water"), m2);
