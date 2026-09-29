package com.flylabs.salary;

import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;
import org.xml.sax.SAXException;
import org.xml.sax.SAXParseException;
import org.xml.sax.helpers.DefaultHandler;
import java.io.IOException;
import java.io.StringReader;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.TreeSet;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.parsers.ParserConfigurationException;

/** Listing href values are names to validate, never URLs to fetch directly. */
final class WebDavListing {
    static final int MAX_BYTES = 1024 * 1024;
    static final int MAX_DELTAS = 1200;
    private static final String DAV = "DAV:";
    private static final String ROOT = "/dav/SalaryTrail/";

    static List<String> parse(String xml) throws IOException {
        if (xml.toUpperCase(Locale.ROOT).contains("<!DOCTYPE") || xml.toUpperCase(Locale.ROOT).contains("<!ENTITY")) throw invalid();
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            factory.setExpandEntityReferences(false);
            try { factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true); }
            catch (ParserConfigurationException ignored) { /* Android parser variants still have the explicit DTD rejection above. */ }
            DocumentBuilder builder = factory.newDocumentBuilder();
            builder.setEntityResolver((publicId, systemId) -> { throw new SAXException("External entities disabled"); });
            builder.setErrorHandler(new DefaultHandler() {
                @Override public void error(SAXParseException error) throws SAXException { throw new SAXException("Invalid WebDAV listing"); }
                @Override public void fatalError(SAXParseException error) throws SAXException { throw new SAXException("Invalid WebDAV listing"); }
            });
            Document document = builder.parse(new InputSource(new StringReader(xml.startsWith("\uFEFF") ? xml.substring(1) : xml)));
            Element root = document.getDocumentElement();
            if (!DAV.equals(root.getNamespaceURI()) || !"multistatus".equals(root.getLocalName())) throw invalid();
            TreeSet<String> names = new TreeSet<>();
            int deltas = 0;
            for (Node child = root.getFirstChild(); child != null; child = child.getNextSibling()) {
                if (!(child instanceof Element)) continue;
                Element response = (Element) child;
                if (!DAV.equals(response.getNamespaceURI()) || !"response".equals(response.getLocalName())) continue;
                String href = null;
                for (Node value = response.getFirstChild(); value != null; value = value.getNextSibling()) {
                    if (value instanceof Element && DAV.equals(value.getNamespaceURI()) && "href".equals(value.getLocalName())) {
                        if (href != null) throw invalid();
                        href = value.getTextContent();
                    }
                }
                String name = fileName(href);
                if (name == null) continue;
                NodeList collections = response.getElementsByTagNameNS(DAV, "collection");
                boolean known = "archive-v1.json".equals(name) || deltaName(name);
                if (!known) continue;
                if (collections.getLength() != 0) throw invalid();
                if (names.add(name) && deltaName(name) && ++deltas > MAX_DELTAS) {
                    throw new ImportStore.UserInputException("云端工资文件超过 1200 份，请先整理备份后再同步");
                }
            }
            return new ArrayList<>(names);
        } catch (ImportStore.UserInputException error) { throw error; }
        catch (Exception error) { throw invalid(); }
    }

    static boolean deltaName(String name) { return name != null && name.matches("changes-[a-f0-9]{64}\\.json"); }

    private static String fileName(String href) throws Exception {
        if (href == null || href.trim().isEmpty()) throw invalid();
        URI value = new URI(href.trim());
        if (value.getRawQuery() != null || value.getRawFragment() != null || value.getRawUserInfo() != null) throw invalid();
        String decoded = value.getPath();
        if (decoded == null || decoded.indexOf('\\') >= 0) throw invalid();
        for (String segment : decoded.split("/", -1)) if (".".equals(segment) || "..".equals(segment)) throw invalid();
        for (int i = 0; i < decoded.length(); i++) if (Character.isISOControl(decoded.charAt(i))) throw invalid();
        URI resolved = new URI(WebDavClient.DIRECTORY).resolve(value);
        if (!"https".equalsIgnoreCase(resolved.getScheme()) || !"dav.jianguoyun.com".equalsIgnoreCase(resolved.getHost())
            || (resolved.getPort() != -1 && resolved.getPort() != 443) || resolved.getRawUserInfo() != null) throw invalid();
        String path = resolved.getPath();
        if (ROOT.equals(path) || ROOT.substring(0, ROOT.length() - 1).equals(path)) return null;
        if (!path.startsWith(ROOT)) throw invalid();
        String name = path.substring(ROOT.length());
        if (name.endsWith("/")) name = name.substring(0, name.length() - 1);
        if (name.isEmpty() || name.contains("/")) throw invalid();
        return name;
    }

    private static ImportStore.UserInputException invalid() {
        return new ImportStore.UserInputException("云端目录响应无效或包含不支持的路径，已停止同步");
    }
}
