// loader.import() fails with a TypeError if no custom fetch hook is defined.

var l = new Loader();
var p = l.import("flowers");
p.then(mod => {
    test.fail("Unexpected success callback: " + uneval(mod));
}, exc => {
    if (exc instanceof TypeError)
        test.pass();
    else
        test.fail("Unexpected exception: " + exc);
});

test.run();
