// Exports are exposed as accessor properties with only a getter.

var m = new Module({x: 1});

var desc = Object.getOwnPropertyDescriptor(m, "x");
assertEq(desc.configurable, false);
assertEq(desc.enumerable, true);
assertEq(typeof desc.get, "function");
assertEq(desc.set, undefined);

var f = desc.get;
assertEq(f(), 1);
