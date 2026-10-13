package app

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestQuoteDailyCachePrivateRequestAndFallback(t *testing.T) {
	f := newFixture(t)
	f.setup(t)
	var calls atomic.Int32
	var failed atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if failed.Load() {
			w.WriteHeader(503)
			return
		}
		if r.URL.Query().Get("type") != "鼓励" || len(r.URL.Query()) != 1 || r.Header.Get("Cookie") != "" {
			t.Error("upstream must receive only category without session or plans")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"text":["积跬步，以至千里。"],"author":["荀子"]}`))
	}))
	defer upstream.Close()
	f.server.quoteURL = upstream.URL + "?type=%E9%BC%93%E5%8A%B1"
	for i := 0; i < 2; i++ {
		r := f.send(t, "GET", "/api/quote", nil)
		expect(t, r, 200)
		q := decode[DailyQuote](t, r)
		if q.Fallback || q.Text != "积跬步，以至千里。" || q.Source != "万象语录" {
			t.Fatal("quote parsing failed")
		}
	}
	if calls.Load() != 1 {
		t.Fatal("same-day quote must be cached")
	}
	f.advance(1)
	failed.Store(true)
	r := f.send(t, "GET", "/api/quote", nil)
	expect(t, r, 200)
	q := decode[DailyQuote](t, r)
	if !q.Fallback || q.Text == "" || q.Date != "2026-10-14" {
		t.Fatal("failure must return local encouragement")
	}
	expect(t, f.send(t, "GET", "/api/quote", nil), 200)
	if calls.Load() != 2 {
		t.Fatal("fallback must avoid repeated upstream requests")
	}
}
