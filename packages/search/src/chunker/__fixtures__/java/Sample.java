package com.example;

import java.util.HashMap;
import java.util.Map;

/** Caches user records in memory. */
public class Sample {
    private final Map<String, String> store;

    public Sample() {
        this.store = new HashMap<>();
    }

    public String get(String id) {
        return store.get(id);
    }

    public void set(String id, String user) {
        store.put(id, user);
    }
}
