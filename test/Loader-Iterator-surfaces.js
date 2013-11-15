// Superficial properties of Loader iterators.

var l = new Loader;
var iter = l.keys();
var LoaderIteratorPrototype = Object.getPrototypeOf(iter);
assertEq(LoaderIteratorPrototype.hasOwnProperty("constructor"), false);
assertEq(Object.getPrototypeOf(LoaderIteratorPrototype), Object.prototype);

assertEq(Object.getPrototypeOf(l.values()), LoaderIteratorPrototype);
assertEq(Object.getPrototypeOf(l.entries()), LoaderIteratorPrototype);
