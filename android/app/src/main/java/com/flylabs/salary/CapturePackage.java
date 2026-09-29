package com.flylabs.salary;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.HashSet;
import java.util.Arrays;
import java.util.Set;

/** Native code checks the envelope; shared TypeScript rules validate amounts and payroll meaning. */
final class CapturePackage {
    static JSONObject parse(String content) throws IOException {
        try {
            JSONObject pack = new JSONObject(content);
            keys(pack, "format", "version", "source", "records");
            if (!"salary-capture".equals(pack.opt("format")) || !(pack.opt("version") instanceof Number)
                || pack.getDouble("version") != 1) throw invalid();
            JSONObject source = pack.getJSONObject("source");
            keys(source, "kind", "page", "capturedAt");
            if (!"feishu-text".equals(source.opt("kind"))) throw invalid();
            if (!"https://hr.hmifo.com/test/#/wages".equals(string(source, "page", 2048))) throw invalid();
            string(source, "capturedAt", 64);
            JSONArray records = pack.getJSONArray("records");
            if (records.length() < 1 || records.length() > 120) throw invalid();
            Set<String> months = new HashSet<>();
            for (int i = 0; i < records.length(); i++) {
                JSONObject record = records.getJSONObject(i);
                keys(record, "payrollMonth", "fields");
                String month = string(record, "payrollMonth", 7);
                if (!month.matches("(?!0000)[0-9]{4}-(0[1-9]|1[0-2])") || !months.add(month)) throw invalid();
                JSONArray fields = record.getJSONArray("fields");
                if (fields.length() < 3 || fields.length() > 256) throw invalid();
                boolean gross = false;
                boolean net = false;
                for (int j = 0; j < fields.length(); j++) {
                    JSONObject field = fields.getJSONObject(j);
                    keys(field, "label", "amountText");
                    String label = string(field, "label", 100).replaceAll("[\\s()（）：:]", "");
                    gross |= label.matches("应发(工资|合计|总额)?");
                    net |= label.matches("实发(工资|合计|总额)?");
                    string(field, "amountText", 64);
                }
                if (!gross || !net) throw invalid();
            }
            return pack;
        } catch (JSONException error) {
            throw invalid();
        }
    }

    static JSONObject single(JSONObject pack, JSONObject record) throws JSONException {
        return new JSONObject().put("format", "salary-capture").put("version", 1)
            .put("source", pack.getJSONObject("source")).put("records", new JSONArray().put(record));
    }

    static String identity(JSONObject pack, JSONObject record) throws JSONException {
        JSONObject source = pack.getJSONObject("source");
        return source.getString("kind") + "\n" + source.getString("page") + "\n" + canonical(record);
    }

    private static String canonical(Object value) throws JSONException {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            List<String> keys = new ArrayList<>();
            Iterator<String> iterator = object.keys();
            while (iterator.hasNext()) keys.add(iterator.next());
            Collections.sort(keys);
            StringBuilder text = new StringBuilder("{");
            for (String key : keys) {
                if (text.length() > 1) text.append(',');
                text.append(JSONObject.quote(key)).append(':').append(canonical(object.get(key)));
            }
            return text.append('}').toString();
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            StringBuilder text = new StringBuilder("[");
            for (int i = 0; i < array.length(); i++) {
                if (i > 0) text.append(',');
                text.append(canonical(array.get(i)));
            }
            return text.append(']').toString();
        }
        return value instanceof String ? JSONObject.quote((String) value) : String.valueOf(value);
    }

    private static String string(JSONObject object, String key, int maximum) throws JSONException, IOException {
        Object value = object.get(key);
        if (!(value instanceof String) || ((String) value).trim().isEmpty() || ((String) value).length() > maximum) throw invalid();
        return (String) value;
    }

    private static void keys(JSONObject object, String... allowed) throws IOException {
        Set<String> remaining = new HashSet<>(Arrays.asList(allowed));
        Iterator<String> keys = object.keys();
        while (keys.hasNext()) if (!remaining.remove(keys.next())) throw invalid();
        if (!remaining.isEmpty()) throw invalid();
    }

    private static ImportStore.UserInputException invalid() {
        return new ImportStore.UserInputException("这不是有效的薪迹工资文件，请从电脑采集工具重新导出");
    }
}
