package bridge

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// initAuth sets package state, where the TypeScript tests re-import the module per
// init; the tests run in order, so each verify sees the init just before it.
func TestAuth(t *testing.T) {
	readToken := func(t *testing.T, dir string) string {
		b, err := os.ReadFile(filepath.Join(dir, "token"))
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(b))
	}
	mustInit := func(t *testing.T, dir string) {
		if _, err := initAuth(dir); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("auth", func(t *testing.T) {
		tmpDir := t.TempDir()
		mustInit(t, tmpDir)
		token := readToken(t, tmpDir)

		t.Run("verifyToken accepts the generated token", func(t *testing.T) {
			if !verifyToken(&token) {
				t.Error("correct token should be accepted")
			}
		})

		t.Run("verifyToken rejects an empty string", func(t *testing.T) {
			if verifyToken(new("")) {
				t.Error("accepted")
			}
		})

		t.Run("verifyToken rejects a wrong token of same length", func(t *testing.T) {
			if verifyToken(new(strings.Repeat("0", len(token)))) {
				t.Error("accepted")
			}
		})

		t.Run("verifyToken rejects a token of different length", func(t *testing.T) {
			for _, c := range []string{"abc", strings.Repeat("a", len(token)-1), strings.Repeat("a", len(token)+1)} {
				if verifyToken(&c) {
					t.Errorf("accepted %q", c)
				}
			}
		})

		t.Run("verifyToken rejects null/undefined", func(t *testing.T) {
			// Go has one nil for both
			if verifyToken(nil) {
				t.Error("accepted")
			}
		})

		t.Run("generates token written to state dir with correct format", func(t *testing.T) {
			if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(token) {
				t.Errorf("new tokens should be 32 hex chars, got %q", token)
			}
		})

		t.Run("keeps a legacy 64-hex token from an older version", func(t *testing.T) {
			dir := t.TempDir()
			legacy := strings.Repeat("ab", 32) // 64 hex chars
			if err := os.WriteFile(filepath.Join(dir, "token"), []byte(legacy), 0o600); err != nil {
				t.Fatal(err)
			}
			mustInit(t, dir)
			if got := readToken(t, dir); got != legacy {
				t.Errorf("token file = %q", got)
			}
			if !verifyToken(&legacy) {
				t.Error("legacy token rejected")
			}
		})

		t.Run("re-uses the same token on a second init call", func(t *testing.T) {
			mustInit(t, tmpDir)
			if second := readToken(t, tmpDir); second != token {
				t.Errorf("%q != %q", second, token)
			}
			if !verifyToken(&token) {
				t.Error("token rejected")
			}
		})

		t.Run("repairs a pre-existing token file with loose permissions", func(t *testing.T) {
			dir := t.TempDir()
			existing := strings.Repeat("cd", 16) // valid 32-hex token
			path := filepath.Join(dir, "token")
			if err := os.WriteFile(path, []byte(existing), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(path, 0o644); err != nil { // world/group-readable, as if pre-existing
				t.Fatal(err)
			}
			mustInit(t, dir)
			// token value preserved, but the mode must be tightened to 0600
			if got := readToken(t, dir); got != existing {
				t.Errorf("token file = %q", got)
			}
			st, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if st.Mode().Perm() != 0o600 {
				t.Errorf("mode = %o", st.Mode().Perm())
			}
		})
	})

	t.Run("extractToken", func(t *testing.T) {
		mustInit(t, t.TempDir())
		check := func(t *testing.T, header, url string, want *string) {
			req := httptest.NewRequest("GET", url, nil)
			if header != "" {
				req.Header.Set("Authorization", header)
			}
			got := extractToken(req)
			if (got == nil) != (want == nil) || got != nil && *got != *want {
				t.Errorf("got %v, want %v", got, want)
			}
		}

		t.Run("extracts token from Authorization Bearer header", func(t *testing.T) {
			check(t, "Bearer mytoken123", "/api/state", new("mytoken123"))
		})

		t.Run("extracts token from ?token= query param", func(t *testing.T) {
			check(t, "", "/ws?token=mytoken123", new("mytoken123"))
		})

		t.Run("prefers Authorization header over query param", func(t *testing.T) {
			check(t, "Bearer headertoken", "/api/state?token=querytoken", new("headertoken"))
		})

		t.Run("returns null when neither header nor param is present", func(t *testing.T) {
			check(t, "", "/api/state", nil)
		})
	})
}

// Not in the TypeScript suite: the parts of URLSearchParams and Node's latin1 header
// values that decide which token reaches verifyToken.
func TestExtractTokenReadsLikeNode(t *testing.T) {
	for _, c := range []struct{ header, url, want string }{
		{"", "/ws?token=%zz&token=abc", "%zz"}, // the first pair wins even when malformed
		{"", "/ws?token=a+b%41%2", "a bA%2"},
		{"", "/ws?token=abc#frag", "abc"},
		{"", "/ws?token=", ""},
		{"Bearer abc\xa0", "/", "abc"},
	} {
		req := httptest.NewRequest("GET", c.url, nil)
		if c.header != "" {
			req.Header.Set("Authorization", c.header)
		}
		got := extractToken(req)
		if c.want == "" && got != nil || c.want != "" && (got == nil || *got != c.want) {
			t.Errorf("%q %q: got %v, want %q", c.header, c.url, got, c.want)
		}
	}
}
