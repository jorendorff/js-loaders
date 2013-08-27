""" render.py - Extract spec text and convert to a Word document. """

import os, shutil, subprocess, tempfile, zipfile
import codecs, markdown, html5lib, re
import xml.etree.ElementTree as ET

section_boundary_re = re.compile(r'^(?=#)', re.MULTILINE)

def preprocess(source):
    """ Heuristically inject additional formatting into the Markdown source. """
    sections = re.split(ur'(?m)^(#.*)$', source)
    result = u''
    for i in range(1, len(sections), 2):
        heading = sections[i]
        body = sections[i + 1]
        names = set()

        # Find names in the heading.
        m = re.search(ur'\([^)]*\)', heading)
        if m is not None:
            names |= set(re.findall(ur'\w+', m.group(0)))

        # Find names in the body.
        for m in re.finditer(ur'\bcalled\s+on\s+an\s+object\s+(\w+)', body):
            names.add(m.group(1))
        for m in re.finditer(ur'(?i)\blet\s+(\w+)\s+be\b', body):
            names.add(m.group(1))

        # Italicize all names in the body.
        pattern = ur'(?<!\*)\b(' + ur'|'.join(names) + ur')\b(?!\*)'
        body = re.sub(pattern, lambda m: u'*' + m.group(1) + u'*', body)

        # Make "this" bold in "the this value".
        body = re.sub(ur'\b(the\s+)this(\s+value)\b',
                      lambda m: m.group(1) + u"**this**" + m.group(2),
                      body)

        # It might be nice to do pretty quotes and apostrophes here. (The
        # standard has pretty quotes in some places and ASCII in others.)

        result += heading + body
    return result

w_ns = u"http://schemas.openxmlformats.org/wordprocessingml/2006/main"
ET.register_namespace("w", w_ns)

def html_to_ooxml(html_element, first_numId, first_abstractNumId):
    html_ns = u"http://www.w3.org/1999/xhtml"

    def w_element(name, content=(), **attrs):
        e = ET.Element(u"{" + w_ns + u"}" + name)
        for k, v in attrs.items():
            e.set(u"{" + w_ns + u"}" + k, v)
        for child in content:
            assert child is not None
            e.append(child)
        return e

    class Paragraph(list):
        __slots__ = ["pStyle", "numId", "ilvl"]
        def __init__(self, runs=(), pStyle=None, numId=None, ilvl=None):
            list.__init__(self, runs)
            self.pStyle = pStyle
            self.numId = numId
            self.ilvl = ilvl

        def to_etree(self):
            content = []

            pPr_content = []
            if self.pStyle is not None:
                pPr_content.append(w_element(u"pStyle", val=self.pStyle))
            if self.numId is not None:
                pPr_content.append(w_element(u"numPr", [
                    w_element(u"numId", val=str(self.numId)),
                    w_element(u"ilvl", val=str(self.ilvl))
                ]))
            if pPr_content:
                pPr = w_element(u"pPr", pPr_content)
                content.append(pPr)

            for run in self:
                content.append(run.to_etree())

            return w_element(u"p", content)

    class Run(unicode):
        __slots__ = ['em', 'strong', 'code']
        def __init__(self, str):
            assert self == str
            self.em = False
            self.strong = False
            self.code = False

        def to_etree(self):
            content = []

            rPr = []
            if self.em:
                rPr.append(w_element(u"i"))
            if self.code or self.strong:
                rPr.append(w_element(u"b"))
            if self.code:
                rPr.append(w_element(u"rFonts", ascii=u"Courier New", hAnsi=u"Courier New"))
            if rPr:
                content.append(w_element(u"rPr", rPr))

            for part in re.split(r"([\f\n])", self):
                if part == "\n": 
                    content.append(w_element(u"br"))
                elif part == "\f":
                    content.append(w_element(u"br", type=u"page"))
                elif part == "\t":
                    content.append(w_element(u"tab"))
                elif part:
                    # need xml:space="preserve"?
                    t = w_element(u"t")
                    if part.strip() != part:
                        t.set("xml:space", "preserve")
                    t.text = part
                    content.append(t)
                else:
                    pass # empty string, do nothing

            return w_element(u"r", content)

    def make_run(text, attrs):
        # Normalize all whitespace to single spaces.
        text = "[" + text + "]"
        text = " ".join(text.split())
        text = text[1:-1]

        # But if this is a NOTE, include a tab.
        if text.startswith("NOTE "):
            text = "NOTE\t" + text[5:]

        r = Run(text)
        for k in attrs:
            if attrs[k]:
                setattr(r, k, True)
        return r

    def element_tag(e):
        tag = e.tag
        if tag.startswith("{" + html_ns + "}"):
            return tag[len("{" + html_ns + "}"):]
        else:
            return tag

    def is_inline(e):
        return element_tag(e) in ('em', 'strong', 'code')

    def content_of_li_element_to_runs_and_blocks(e, attrs):
        runs = []
        blocks = []
        if e.text:
            runs.append(make_run(e.text, attrs))
        for child in e:
            if is_inline(child):
                assert len(blocks) == 0
                runs += list(convert_inline(child))
                if child.tail:
                    runs.append(make_run(child.tail, attrs))
            else:
                blocks.append(child)
        return runs, blocks

    def content_of_element_to_runs(e, attrs):
        if e.text:
            yield make_run(e.text, attrs)
        for child in e:
            for run in convert_inline(child):
                yield run
            if child.tail:
                yield make_run(child.tail, attrs)

    def convert_inline(e, **attrs):
        tag = element_tag(e)
        if tag in ("em", "strong", "code"):
            attrs[tag] = True
            for run in content_of_element_to_runs(e, attrs):
                yield run
        else:
            raise Exception("unrecognized tag: <" + tag + ">")

    def content_to_para(e, preserve_space=False, pStyle=None):
        content = list(content_of_element_to_runs(e, {}))
        if pStyle is None and content and content[0].startswith("NOTE\t"):
            pStyle = "Note"
        p = Paragraph(content, pStyle)
        return p

    def convert_li(e, numId, pStyle, list_level):
        assert element_tag(e) == "li"
        assert e.tail is None or e.tail.isspace()

        runs, blocks = content_of_li_element_to_runs_and_blocks(e, {})
        yield Paragraph(runs, pStyle=pStyle, numId=numId, ilvl=list_level - 1)
        for child in blocks:
            for p in convert_block(child, numId=numId, list_level=list_level):
                yield p

    next_numId = [first_numId]
    next_abstractNumId = [first_abstractNumId]
    num_pairs = []
    def convert_block(e, numId=None, list_level=0):
        if e.tail and e.tail.strip():
            raise Exception("unexpected tail! {!r}".format(e.tail))
        tag = element_tag(e)
        if tag == "p":
            yield content_to_para(e)
        elif tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            yield content_to_para(e, pStyle=tag.replace('h', 'Heading'))
        elif tag in ('ul', 'ol'):
            if list_level == 0:
                numId = next_numId[0]
                if tag == "ul":
                    # This magic numeric id is glurked from the document.
                    abstractNumId = 24
                else:
                    abstractNumId = next_abstractNumId[0]
                    next_abstractNumId[0] += 1
                num_pairs.append((numId, abstractNumId))
                next_numId[0] += 1

            if tag == 'ul':
                pStyle = "BulletNotlast"
            else:
                pStyle = "Alg4"

            for child in e:
                for p in convert_li(child, numId, pStyle, list_level=list_level + 1):
                    yield p
        elif tag == "blockquote":
            if list_level != 0:
                raise Exception("can't convert a blockquote inside a list")
            for child in e:
                for p in convert_block(child, numId, list_level + 1):
                    yield p
        elif tag == "pre":
            if len(e) == 1 and e[0].tag == "{" + html_ns + "}code":
                e = e[0]
            # TODO: produce multiple paragraphs rather than one containing hard breaks
            yield content_to_para(e, pStyle="CodeSample3", preserve_space=True)
        elif tag == "hr":
            yield Paragraph([Run("\f")])
        else:
            raise Exception("unrecognized tag: <" + tag + ">")

    paragraphs = []
    for child in html_element.find("{" + html_ns + "}body"):
        for wp in convert_block(child):
            paragraphs.append(wp.to_etree())

    body = w_element("body", paragraphs)
    return w_element("document", [body]), num_pairs

def main(source_file, output_file):
    # First, extract two numbers that we need from the source docx file.
    # This is rather incredible but we do need them.
    src_dir = os.path.dirname(__file__)
    blank_docx_file = os.path.join(src_dir, "blank.docx")
    zf = zipfile.ZipFile(blank_docx_file, "r")
    f = zf.open("word/numbering.xml")
    numbering_xml_bytes = f.read()
    numbering_etree = ET.fromstring(numbering_xml_bytes)
    zf.close()

    def w(name):
        return u"{" + w_ns + u"}" + name

    first_numId = max(int(num.get(w(u"numId")))
                      for num in numbering_etree.findall(w(u"num"))) + 1
    first_abstractNumId = max(int(num.get(w(u"abstractNumId")))
                              for num in numbering_etree.findall(w(u"abstractNum"))) + 1

    # Load the file, stripping out everything not prefixed with "//>".
    # Treat as bytes; it works because UTF-8 is nice.
    lines = []
    with codecs.open(source_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            # TODO: run the pipeline separately for each sequence of //> lines
            # so as not to require extra "blank" //> lines to separate paragraphs.
            if line.startswith(u"//>"):
                line = line[3:]
                if line.startswith(u' '):
                    line = line[1:]
                lines.append(line + u"\n")

    source = u"".join(lines)
    source = preprocess(source)

    # Render from markdown to html to OOXML.
    html = markdown.markdown(source)
    #print(html)
    html_element = html5lib.parse(html, treebuilder="etree")
    word_element, num_pairs = html_to_ooxml(html_element, first_numId, first_abstractNumId)

    # Word refuses to open the file if we re-serialize the XML, even though the
    # infoset hasn't changed. Classy. I don't have the patience to figure out
    # which xmlns:wtf attribute I need to add. So hack the raw XML bytes
    # instead. (Works.)
    def insert_after(s, pattern, extra):
        print("INSERTING:", extra)
        i = s.rindex(pattern)
        if i == -1:
            raise ValueError("insert_after: pattern not found")
        i += len(pattern)
        return s[:i] + extra + s[i:]

    numbering_xml_bytes = insert_after(
        numbering_xml_bytes, "</w:num>",
        "".join('<w:num w:numId="{}"><w:abstractNumId w:val="{}"/></w:num>'.format(k, v)
                for k, v in num_pairs))
    numbering_xml_bytes = insert_after(
        numbering_xml_bytes, "</w:abstractNum>",
        "".join('<w:abstractNum w:abstractNumId="{}">'
                  '<w:multiLevelType w:val="multilevel"/>'
                  '<w:numStyleLink w:val="ag3"/>'
                '</w:abstractNum>'.format(v)
                for k, v in num_pairs if v > 1000))

    # Generate output.
    temp_dir = tempfile.mkdtemp()
    output_docx = "modules.docx"
    temp_output_docx = os.path.join(temp_dir, output_docx)
    try:
        shutil.copy(blank_docx_file, temp_output_docx)
        os.mkdir(os.path.join(temp_dir, "word"))
        with open(os.path.join(temp_dir, "word", "document.xml"), "wb") as f:
            f.write(ET.tostring(word_element, encoding="UTF-8"))
        with open(os.path.join(temp_dir, "word", "numbering.xml"), "wb") as f:
            f.write(numbering_xml_bytes)
        subprocess.check_call(
            ["zip", "-u", output_docx, "word/document.xml", "word/numbering.xml"],
            cwd=temp_dir)
        if os.path.exists(output_docx):
            os.remove(output_docx)
        shutil.move(temp_output_docx, output_file)
    finally:
        shutil.rmtree(temp_dir)


if __name__ == "__main__":
    repo_root_dir = os.path.dirname(os.path.dirname(__file__))
    default_js_file = os.path.join(repo_root_dir, "../impl.js")

    import argparse
    parser = argparse.ArgumentParser(
        prog="python render.py",
        description="Convert some JS comments to a Word document.")
    parser.add_argument(
        'source_file',
        metavar="FILE",
        nargs='?',
        default=default_js_file,
        help="JS source files to process (default: ../impl.js)")
    parser.add_argument(
        '-o',
        metavar="FILE",
        default=os.path.abspath("modules.docx"),
        help="output file (default: modules.docx)")
    args = parser.parse_args()
    main(args.source_file, args.o)
