""" render.py - Extract spec text and convert to a Word document. """

import os, shutil, subprocess, tempfile
import codecs, markdown, html5lib, re
import xml.etree.ElementTree as ET

def html_to_ooxml(html_element):
    html_ns = u"http://www.w3.org/1999/xhtml"

    w_ns = u"http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    ET.register_namespace(w_ns, u"w")

    def w_element(name, content=(), **attrs):
        e = ET.Element(u"{" + w_ns + u"}" + name)
        for k, v in attrs.items():
            e.set(u"{" + w_ns + u"}" + k, v)
        for child in content:
            assert child is not None
            e.append(child)
        return e

    class Paragraph(list):
        __slots__ = ["pStyle"]
        def __init__(self, runs=(), pStyle=None):
            list.__init__(self, runs)
            self.pStyle = pStyle

        def to_etree(self):
            content = []
            if self.pStyle is not None:
                pStyle = w_element(u"pStyle", val=self.pStyle)
                pPr = w_element(u"pPr", [pStyle])
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

        r = Run(text)
        for k in attrs:
            if attrs[k]:
                setattr(r, k, True)
        return r

    def content_of_element_to_runs(e, **attrs):
        if e.text:
            yield make_run(e.text, attrs)
        for child in e:
            for run in convert_inline(child):
                yield run
            if child.tail:
                yield make_run(child.tail, attrs)

    def convert_inline(e, **attrs):
        tag = e.tag
        if tag.startswith("{" + html_ns + "}"):
            tag = tag[len("{" + html_ns + "}"):]

        if tag in ("em", "strong", "code"):
            attrs[tag] = True
            for run in content_of_element_to_runs(e, **attrs):
                yield run
        else:
            raise Exception("unrecognized tag: <" + tag + ">")

    def content_to_para(e, list_style=None, list_level=None, preserve_space=False, pStyle=None):
        content = list(content_of_element_to_runs(e))
        return Paragraph(content, pStyle)

    def convert_block(e, list_style=None, list_level=0):
        if e.tail and e.tail.strip():
            raise Exception("unexpected tail! {!r}".format(e.tail))
        tag = e.tag
        if tag.startswith("{" + html_ns + "}"):
            tag = tag[len("{" + html_ns + "}"):]
        if tag == "p":
            yield content_to_para(e)
        elif tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            yield content_to_para(e, pStyle=tag.replace('h', 'Heading'))
        elif tag in ('ul', 'ol'):
            for child in e:
                for p in convert_block(child, tag, list_level + 1):
                    yield p
        elif tag == "li":
            yield content_to_para(e, list_style, list_level)
        elif tag == "blockquote":
            if list_level != 0:
                raise Exception("can't convert a blockquote inside a list")
            for child in e:
                for p in convert_block(child, list_style, list_level + 1):
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
    return w_element("document", [body])

def main():
    # Load the file, stripping out everything not prefixed with "//>".
    # Treat as bytes; it works because UTF-8 is nice.
    lines = []
    with codecs.open("../impl.js", encoding="utf-8") as f:
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

    # Render from markdown to html to OOXML.
    html = markdown.markdown(source)
    print(html)
    html_element = html5lib.parse(html, treebuilder="etree")
    word_element = html_to_ooxml(html_element)

    print(ET.tostring(word_element, encoding="UTF-8"))

    src_dir = os.path.dirname(__file__)
    temp_dir = tempfile.mkdtemp()
    output_docx = "modules.docx"
    try:
        shutil.copy(os.path.join(src_dir, "blank.docx"),
                    os.path.join(temp_dir, output_docx))
        os.mkdir(os.path.join(temp_dir, "word"))
        with open(os.path.join(temp_dir, "word", "document.xml"), "wb") as f:
            f.write(ET.tostring(word_element, encoding="UTF-8"))
        subprocess.check_call(["zip", "-u", output_docx, "word/document.xml"],
                              cwd=temp_dir)
        if os.path.exists(output_docx):
            os.remove(output_docx)
        shutil.move(os.path.join(temp_dir, output_docx),
                    os.curdir)
    finally:
        shutil.rmtree(temp_dir)


if __name__ == "__main__":
    main()
