# How to run these scripts

You will need Python 2.7 and virtualenv.

1.  You probably already have a good enough Python.
    If not, grab one from [python.org](http://python.org/).

2.  If you don&rsquo;t have virtualenv (try `which virtualenv`) then
    these commands might install it for you:

        curl http://python-distribute.org/distribute_setup.py | sudo python
        curl https://raw.github.com/pypa/pip/master/contrib/get-pip.py | sudo python
        sudo pip install virtualenv

    Let me know if they don't work.

3.  The following commands will set up a local environment for you.

        virtualenv venv
        . ./venv/bin/activate
        pip install -r requirements.txt

    This creates a directory `./venv` and downloads a few Python
    libraries and installs them there (not globally).

4.  To generate a Word document from Loader.js, the command is:

        python render.py

    The output document is `./modules.docx`.

5.  To generate HTML from Loader.js, the command is:

        python schlocco.py ../Loader.js

    By default, the output document is `./docs/Loader.html`. This script
    accepts command-line arguments to change the default; run
    `python schlocco.py --help` for details.

You don&rsquo;t need to repeat all those steps every time.
If you&rsquo;ve done it once, subsequently you can just:

    . ./venv/bin/activate

and then you&rsquo;re ready for step 4 or 5.
