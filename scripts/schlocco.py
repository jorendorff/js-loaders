#!/bin/env python

"""schnocco.py - A badly-behaved port of [Docco](http://jashkenas.github.io/docco/).

This is directly descended from the delightful literate-CoffeeScript original.
Differences from Docco:

* I dropped every feature I didn't need.

* The generated markup is quite different. Docco presents code and
  documentation as alterating <div> elements. This is elegant, but suppose the
  program looks like this:

      // 1. Start the TARDIS.
      tardis.start().

      // 2. Put the sonic screwdriver in your waistcoat pocket.
      var ssd = glob("/dev/ssd*")[0];
      mv(ssd, pocket);

  Docco would run each comment through Markdown separately, generating two
  separate ordered lists, each starting with the number 1.

  So in schnocco, all the documentation is run through Markdown as a single
  unit. Code is inelegantly wedged into the documentation HTML and rendered
  using deeply preposterous CSS.
"""

import argparse, cgi, codecs, os, re, shutil
import markdown
import pygments, pygments.lexers, pygments.formatters

def document(options):
    if not os.path.isdir(options.output):
        os.makedirs(options.output)

    def copyAsset(file):
        shutil.copy(file, os.path.join(options.output, os.path.basename(file)))

    for filename in options.sources:
        with codecs.open(filename, 'rt', encoding='utf-8') as f:
            code = f.read()
            sections = parse(code, options)
            rendered_sections = format(sections, options)
            write(filename, rendered_sections, options)
    copyAsset(options.css)
    ## if os.path.exists(options.public):
    ##     copyAsset(options.public)

def parse(code, options):
    """ Given a string of source code, **parse** out each block of prose and the code that
    follows it -- by detecting which is which, line by line -- and then create an
    individual **section** for it. Each section is an object with `docsText` and
    `codeText` properties, and eventually `docsHtml` and `codeHtml` as well.
    """
    lines = code.splitlines()
    sections = []
    pieces = ['', '']

    def save():
        result = tuple(pieces)
        pieces[:] = ['', '']
        return result

    # Our quick-and-dirty implementation of the literate programming style. Simply
    # invert the prose and code relationship on a per-line basis, and then continue as
    # normal below.

    commentMatcher = re.compile(r'^\s*//\s?')

    for line in lines:
        match = re.match(commentMatcher, line)
        if match:
            if pieces[1]:
                yield save()
            pieces[0] += line[match.end():] + "\n"
            if "---" in line or "===" in line:
                yield save()
        else:
            pieces[1] += line + "\n"
    yield save()

def format(sections, config):
    """To **format** and highlight the now-parsed sections of code, we use
    Pygments over the codeText, and run the text of their corresponding
    comments through **Markdown**. """

    docs_segments = []
    code_segments = []

    # For each section, we have both docs_text (really Markdown) and code_text.
    # We'll attempt to put a *tag* somewhere near the beginning of the
    # docs_text that will not disrupt Markdown's layout algorithm. To do this,
    # we use a regexp to match the initial part of docs_text that we must not
    # disrupt. (Since this regexp matches the empty string, we don't have to worry
    # about failing to match.)


    markdown_start = re.compile(
        r'''(?x)
        (
            [ \t>]* \# .* \n    # put the marker after any headings
          |
            [ \t>]*\n           # or blank lines
        )*

        (?:[ \t]* >)?           # put the marker after a blockquote-mark, if any
        [ \t]*                  # put the marker after all whitespace on the line
        (?:(?: [1-9][0-9]*\.
             | \*[ ]
           )[ \t]*)?            # put it after the list-item marker on this line, if any
        ''')

    lexer = pygments.lexers.get_lexer_by_name("javascript")
    formatter = pygments.formatters.HtmlFormatter(nowrap=True)
    for n, (docs_text, code_text) in enumerate(sections):
        match = re.match(markdown_start, docs_text)
        left = docs_text[:match.end()]
        right = docs_text[match.end():]
        if right == '':
            right = '\n'
        docs_text = left + "(schnocco-source-code-segment-{})".format(n) + right

        # Add a blank line between sections, unless this section starts with a
        # numbered list item.
        if re.match(r'^> *\d+\.', docs_text) is None:
            if docs_text.startswith(">"):
                blank = ">\n"
            else:
                blank = "\n"
            docs_text = blank + docs_text

        docs_segments.append(docs_text)

        code_html = pygments.highlight(code_text, lexer, formatter)

        # Amazingly, pygments strips trailing blank lines. Rather than
        # painstakingly correcting for this insult, just tack on an extra
        # newline.
        code_html += "\n"

        codespan_html = '<span class="src"><code>' + code_html + '</code></span>'
        code_segments.append(codespan_html)

    all_docs_md = ''.join(docs_segments)
    docs_html = markdown.markdown(all_docs_md)

    # Substitute code segments into the generated HTML.
    return re.sub(r'\(schnocco-source-code-segment-([0-9]+)\)',
                  lambda match: code_segments[int(match.group(1))],
                  docs_html)

def write(source_filename, sections_html, config):
    """ Once all of the code has finished highlighting, we can **write** the
    resulting documentation file by passing the completed HTML sections into
    the template, and rendering it to the specified output path.

    (This requires a template thingy, of which there are oodles but I haven't
    got one installed in this virtualenv)
    """

    def destination(file):
        return os.path.join(config.output, os.path.splitext(os.path.basename(file))[0] + ".html")

    pyg_css = pygments.formatters.HtmlFormatter().get_style_defs('span.src > code')

    # TODO: <title>
    html = ('<!doctype html>\n'
            + '<html>\n'
            + '<head>\n'
            + '  <meta charset="utf-8">\n'
            + '  <!-- css generated by pygments -->\n'
            + '  <style type="text/css">{}</style>\n'.format(pyg_css)
            + '  <link rel="stylesheet" type="text/css" href="{}">\n'.format(os.path.basename(config.css))
            + '</head>\n'
            + '<body>\n'
            + sections_html
            + '</body>\n'
            + '</html>\n')

    dest = destination(source_filename)
    print("schnocco: {} -> {}".format(source_filename, dest))
    with codecs.open(dest, 'w', encoding='utf-8') as out:
        out.write(html)
 
def main():
    """ Finally, let's define the interface to run Schnocco from the command line.
    Parse options using argparse. """

    parser = argparse.ArgumentParser(description="make a big HTML mess")
    parser.add_argument("sources", metavar="FILE", nargs="+", type=str,
                        help="a source file to render as HTML")
    parser.add_argument("-l", "--layout", metavar="NAME", default='parallel',
                        help="choose a layout (parallel, linear or classic)")
    parser.add_argument("-o", "--output", metavar="PATH", default='docs',
                        help="output to a given folder")
    parser.add_argument("-c", "--css", metavar="FILE",
                        help="use a custom css file")
    ##.option('-t, --template [file]',  'use a custom .jst template', c.template)
    ##.option('-e, --extension [ext]',  'assume a file extension for all inputs', c.extension)

    args = parser.parse_args()
    dir = os.path.join(os.path.dirname(__file__), "resources")
    if args.css is None:
        args.css = os.path.join(dir, "schnocco.css")
    document(args)

if __name__ == '__main__':
    main()
