package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResourceUsageRequiresLoginAndReportsRealFiles(t *testing.T) {
	f := newFixture(t)
	expect(t, f.send(t, "GET", "/api/resources", nil), 401)
	f.setup(t)
	response := f.send(t, "GET", "/api/resources", nil)
	expect(t, response, 200)
	usage := decode[resourceUsage](t, response)
	if usage.CloudflareConnected || usage.Memory.Source != "go_heap" || usage.Memory.UsedBytes == nil || *usage.Memory.UsedBytes == 0 {
		t.Fatalf("unexpected memory/provider: %+v", usage)
	}
	if usage.Storage.Source != "sqlite_files" || usage.Storage.UsedBytes == nil || *usage.Storage.UsedBytes == 0 || usage.UpdatedAt != stamp(f.server.now()) {
		t.Fatalf("unexpected storage/time: %+v", usage)
	}
	var sequence int
	var name, filename string
	if err := f.server.db.QueryRow("PRAGMA database_list").Scan(&sequence, &name, &filename); err != nil {
		t.Fatal(err)
	}
	var expected uint64
	for _, path := range []string{filename, filename + "-wal"} {
		info, err := os.Stat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		expected += uint64(info.Size())
	}
	if *usage.Storage.UsedBytes != expected {
		t.Fatalf("storage=%d want actual files=%d", *usage.Storage.UsedBytes, expected)
	}
	if strings.Contains(response.Body.String(), filename) || strings.Contains(response.Body.String(), filepath.Dir(filename)) {
		t.Fatal("resource response leaks a server path")
	}
}

func TestUnavailableResourceStorageIsNotReportedAsZero(t *testing.T) {
	f := newFixture(t)
	if err := f.server.db.Close(); err != nil {
		t.Fatal(err)
	}
	if got := f.server.sqliteStorageBytes(context.Background()); got != nil {
		t.Fatalf("closed database should be unavailable, got %d", *got)
	}
}
