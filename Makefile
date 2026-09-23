.PHONY: typecheck test check pack-check prepublish-only

typecheck:
	npm run typecheck

test:
	npm test

check:
	npm run check

pack-check:
	npm run pack:check

prepublish-only:
	npm run prepublishOnly
