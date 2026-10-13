package app

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

type DailyQuote struct {
	Date     string `json:"date"`
	Text     string `json:"text"`
	Author   string `json:"author"`
	Source   string `json:"source"`
	Fallback bool   `json:"fallback"`
}

var encouragements = []string{"每天向前一点，也是一种坚持。", "把今天能做的一步，认真做好。", "不必一次走很远，今天开始就很好。", "允许自己慢一点，也记得继续前行。", "每一次小小的完成，都在积累力量。"}

func (s *Server) quote(c *gin.Context) {
	s.quoteMu.Lock()
	defer s.quoteMu.Unlock()
	date := s.now().In(s.location).Format("2006-01-02")
	q := DailyQuote{Date: date}
	err := s.db.QueryRowContext(c.Request.Context(), "SELECT text,author,source,fallback FROM daily_quotes WHERE date=?", date).Scan(&q.Text, &q.Author, &q.Source, &q.Fallback)
	if err == nil {
		c.JSON(200, q)
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		s.internal(c, err)
		return
	}
	// The upstream receives only a fixed category; no account or plan data leaves this service.
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, s.quoteURL, nil)
	if err == nil {
		var response *http.Response
		response, err = s.quoteClient.Do(req)
		if err == nil {
			var body struct {
				Text   []string `json:"text"`
				Author []string `json:"author"`
			}
			if response.StatusCode == 200 {
				err = json.NewDecoder(io.LimitReader(response.Body, 16*1024)).Decode(&body)
			} else {
				err = errors.New("quote unavailable")
			}
			response.Body.Close()
			if err == nil && len(body.Text) > 0 {
				q.Text = strings.Join(strings.Fields(body.Text[0]), " ")
				if utf8.RuneCountInString(q.Text) > 160 {
					q.Text = ""
				}
				if len(body.Author) > 0 {
					q.Author = strings.TrimSpace(body.Author[0])
					if utf8.RuneCountInString(q.Author) > 80 {
						q.Author = ""
					}
				}
				if q.Text != "" {
					q.Source = "万象语录"
				}
			}
		}
	}
	if q.Text == "" {
		q.Text = encouragements[s.now().In(s.location).YearDay()%len(encouragements)]
		q.Author = ""
		q.Source = "内置文案"
		q.Fallback = true
	}
	if _, err := s.db.ExecContext(c.Request.Context(), "INSERT INTO daily_quotes(date,text,author,source,fallback) VALUES(?,?,?,?,?)", q.Date, q.Text, q.Author, q.Source, q.Fallback); err != nil {
		s.internal(c, err)
		return
	}
	c.JSON(200, q)
}
