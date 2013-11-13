// .has() checks whether a key is in the module registry.

var l = new Loader;
assertEq(l.has("water"), false);
l.set("water", new Module({}));
assertEq(l.has("water"), true);
l.delete("water");
assertEq(l.has("water"), false);
