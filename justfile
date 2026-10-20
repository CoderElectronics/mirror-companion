setup:
	curl -fsSL https://tinyjs.app/install | sh

build:
	tinyjs build

dev:
	tinyjs dev

clean:
	rm -rf dist node_modules .build || true
