package app

import (
	"context"
	"os"
	"runtime"

	"github.com/gin-gonic/gin"
)

type resourceMetric struct {
	UsedBytes *uint64 `json:"usedBytes"`
	Source    string  `json:"source"`
}

type resourceUsage struct {
	Memory              resourceMetric `json:"memory"`
	Storage             resourceMetric `json:"storage"`
	CloudflareConnected bool           `json:"cloudflareConnected"`
	UpdatedAt           string         `json:"updatedAt"`
}

func (s *Server) resources(c *gin.Context) {
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	used := memory.HeapAlloc
	c.JSON(200, resourceUsage{
		Memory:  resourceMetric{UsedBytes: &used, Source: "go_heap"},
		Storage: resourceMetric{UsedBytes: s.sqliteStorageBytes(c.Request.Context()), Source: "sqlite_files"},
		// Cloudflare account metrics are not connected in the local deployment.
		CloudflareConnected: false,
		UpdatedAt:           stamp(s.now()),
	})
}

// Count actual database and WAL file bytes, including recoverable/deleted rows.
// Do not expose the filesystem path or guess a cloud quota.
func (s *Server) sqliteStorageBytes(ctx context.Context) *uint64 {
	rows, err := s.db.QueryContext(ctx, "PRAGMA database_list")
	if err != nil {
		return nil
	}
	var filename string
	for rows.Next() {
		var sequence int
		var name, path string
		if err := rows.Scan(&sequence, &name, &path); err != nil {
			rows.Close()
			return nil
		}
		if name == "main" {
			filename = path
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil || filename == "" {
		return nil
	}
	var total uint64
	for index, path := range []string{filename, filename + "-wal"} {
		info, err := os.Stat(path)
		if index == 1 && os.IsNotExist(err) {
			continue
		}
		if err != nil || !info.Mode().IsRegular() || info.Size() < 0 {
			return nil
		}
		total += uint64(info.Size())
	}
	return &total
}
