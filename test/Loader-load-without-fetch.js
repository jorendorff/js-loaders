var l = new Loader();
var p = l.load("flowers");
p.then(mod => {
    test.fail("Unexpected success callback: " + uneval(mod));
}, exc => {
    if (exc instanceof TypeError)
        test.pass();
    else
        test.fail("Unexpected exception: " + exc);
});

test.run();
