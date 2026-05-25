/**
 * Stack detector for the SDK auto-install setup endpoint (W5).
 *
 * Operates on a list of `{path, content}` pairs fetched from the supervisor
 * (we cannot stat the user's machine directly), unlike the self-heal version
 * which walked the filesystem. Restricted to the 4 stacks Wave 5 supports:
 *
 *   - node-nextjs   (next.config.{js,ts,mjs} present)
 *   - node-express  (package.json has `express` AND no next.config.*)
 *   - python-django (manage.py present OR wsgi.py contains django.core.wsgi)
 *   - python-fastapi (any *.py contains `from fastapi import FastAPI` or `FastAPI(`)
 *
 * Order: nextjs > express > django > fastapi. First match wins.
 *
 * Lifted in spirit from claude-code-self-heal/src/setup/detect.ts but
 * collapsed to a content-driven, single-pass matcher.
 */

export type Stack = 'node-express' | 'node-nextjs' | 'python-fastapi' | 'python-django'

export interface RepoFile {
  path: string  // repo-relative, posix slashes
  content: string
}

export interface DetectSuccess {
  stack: Stack
  entry_file: string       // repo-relative path of the file to inject the snippet into
  manifest_file: string    // package.json or requirements.txt
}

export interface DetectFailure {
  stack: null
  tried: string[]          // human-readable list of negative signals
}

export type DetectResult = DetectSuccess | DetectFailure

function findFile(files: RepoFile[], predicate: (f: RepoFile) => boolean): RepoFile | undefined {
  return files.find(predicate)
}

export function detectStack(files: RepoFile[]): DetectResult {
  const tried: string[] = []
  const has = (path: string) => files.some(f => f.path === path)
  const findExt = (basenames: string[]): RepoFile | undefined =>
    files.find(f => basenames.includes(f.path))

  const packageJson = findFile(files, f => f.path === 'package.json')
  const requirementsTxt = findFile(files, f => f.path === 'requirements.txt')

  // 1. Next.js
  const nextConfig = findExt(['next.config.js', 'next.config.ts', 'next.config.mjs'])
  if (nextConfig) {
    if (!packageJson) {
      tried.push('next.config.* present but no package.json')
    } else {
      return {
        stack: 'node-nextjs',
        entry_file: nextConfig.path,
        manifest_file: 'package.json',
      }
    }
  } else {
    tried.push('no next.config.{js,ts,mjs}')
  }

  // 2. Express — package.json has express dep
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson.content) as {
        dependencies?: Record<string, string>
        main?: string
      }
      const deps = pkg.dependencies || {}
      if (deps['express']) {
        // pick entry: pkg.main if present, else first of common entries
        const candidates = [
          pkg.main,
          'src/index.ts', 'src/index.js',
          'src/server.ts', 'src/server.js',
          'src/app.ts', 'src/app.js',
          'index.ts', 'index.js',
          'server.ts', 'server.js',
          'app.ts', 'app.js',
        ].filter(Boolean) as string[]
        const entry = candidates.find(c => has(c))
        if (entry) {
          return { stack: 'node-express', entry_file: entry, manifest_file: 'package.json' }
        }
        tried.push('express dep present but no entry file found')
      } else {
        tried.push('package.json missing express dep')
      }
    } catch {
      tried.push('package.json unparseable')
    }
  } else {
    tried.push('no package.json')
  }

  // 3. Django — manage.py or wsgi.py with django.core.wsgi
  if (has('manage.py')) {
    if (!requirementsTxt) {
      tried.push('manage.py present but no requirements.txt')
    } else {
      return { stack: 'python-django', entry_file: 'manage.py', manifest_file: 'requirements.txt' }
    }
  } else {
    const wsgi = findFile(files, f => f.path.endsWith('wsgi.py'))
    if (wsgi && wsgi.content.includes('django.core.wsgi')) {
      if (!requirementsTxt) {
        tried.push('django wsgi.py present but no requirements.txt')
      } else {
        return { stack: 'python-django', entry_file: wsgi.path, manifest_file: 'requirements.txt' }
      }
    } else {
      tried.push('no manage.py / django wsgi.py')
    }
  }

  // 4. FastAPI — any *.py with `from fastapi import FastAPI` or `FastAPI(`
  const fastapiFile = findFile(files, f =>
    f.path.endsWith('.py') &&
    (f.content.includes('from fastapi import FastAPI') || /FastAPI\s*\(/.test(f.content))
  )
  if (fastapiFile) {
    if (!requirementsTxt) {
      tried.push('FastAPI usage present but no requirements.txt')
    } else {
      return { stack: 'python-fastapi', entry_file: fastapiFile.path, manifest_file: 'requirements.txt' }
    }
  } else {
    tried.push('no FastAPI usage')
  }

  return { stack: null, tried }
}
