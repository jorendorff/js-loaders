// An empty Module has no properties. Its prototype is null.

var m = new Module({});
assertEq(typeof m, "object");
assertEq(Object.getPrototypeOf(m), null);
assertEq(Object.getOwnPropertyNames(m).length, 0);
