<?php
/**
 * OMGBBManager - PHP backend for shared hosting (Apache + PHP, no Node).
 *
 * Exposes exactly the same JSON API as server.js, so the browser code is
 * identical either way:
 *
 *   GET  api/collection      read the collection
 *   POST api/collection      write it (PUT also accepted)
 *   GET  api/index           read the part catalogue
 *   POST api/index           write it
 *   GET  api/wiki?...        cached + rate limited proxy to the Beyblade Wiki
 *   GET  api/status          storage and budget self-check
 *
 * Apache rewrites api/<route> to api.php?route=<route>; see .htaccess.
 * Requires PHP 7.0+ with the curl extension (allow_url_fopen is used as a
 * fallback). No other dependencies.
 */

// --------------------------------------------------------------- configuration

/**
 * Where the JSON lives. By default the app looks for a "data" directory next to
 * the application directory (outside the web root on a normal cPanel layout,
 * where the app sits in public_html), then falls back to ./data.
 *
 * To pin it somewhere explicit - recommended when the app lives in a subfolder -
 * uncomment the next line and set your own path.
 */
// define('OMGBB_DATA_DIR', '/home/YOURUSER/omgbb-data');

define('OMGBB_WIKI_API', 'https://beyblade.fandom.com/api.php');
define('OMGBB_USER_AGENT', 'OMGBBManager/1.0 (personal Beyblade X collection manager; single-user, manual fetch only)');
define('OMGBB_MIN_GAP_MS', 1100);   // minimum spacing between two upstream requests
define('OMGBB_HOURLY_BUDGET', 300); // hard ceiling per rolling hour
define('OMGBB_MAX_BODY', 8388608);  // 8 MB
define('OMGBB_BACKUPS', 40);

@set_time_limit(60);

$ALLOWED_PARAMS = array(
    'action', 'format', 'formatversion', 'page', 'prop', 'titles', 'redirects',
    'list', 'srsearch', 'srlimit', 'srnamespace', 'cmtitle', 'cmlimit',
    'cmcontinue', 'search', 'limit', 'namespace', 'rvprop', 'rvslots', 'section', 'cllimit', 'acprefix', 'aclimit', 'cmnamespace', 'rvsection', 'rvcontinue', 'continue',
);
$ALLOWED_ACTIONS = array('parse', 'query', 'opensearch');

// -------------------------------------------------------------------- helpers

function send_json($status, $payload)
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function fail($status, $message)
{
    send_json($status, array('error' => $message));
}

/** Create a directory and, if it is inside the web root, lock it down. */
function ensure_dir($path)
{
    if (!is_dir($path) && !@mkdir($path, 0755, true) && !is_dir($path)) {
        return false;
    }
    $guard = $path . '/.htaccess';
    if (!file_exists($guard)) {
        @file_put_contents(
            $guard,
            "# Collection data - never serve this over the web.\n" .
            "<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n" .
            "<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\n"
        );
    }
    return true;
}

/**
 * Resolve the storage directory once and cache it for this request.
 * Preference: explicit override, then ../data, then ./data.
 */
function data_dir()
{
    static $resolved = null;
    if ($resolved !== null) {
        return $resolved;
    }
    if (defined('OMGBB_DATA_DIR')) {
        $resolved = rtrim(OMGBB_DATA_DIR, '/\\');
        ensure_dir($resolved);
        return $resolved;
    }

    $outside = dirname(__DIR__) . '/data';
    $inside = __DIR__ . '/data';

    if (is_dir($outside) && is_writable($outside)) {
        $resolved = $outside;
    } elseif (is_dir($inside) && is_writable($inside)) {
        $resolved = $inside;
    } elseif (is_writable(dirname(__DIR__)) && ensure_dir($outside)) {
        $resolved = $outside;
    } else {
        ensure_dir($inside);
        $resolved = $inside;
    }
    return $resolved;
}

function read_json_file($file, $default)
{
    if (!is_file($file)) {
        return $default;
    }
    $raw = @file_get_contents($file);
    if ($raw === false || $raw === '') {
        return $default;
    }
    $parsed = json_decode($raw, true);
    return is_array($parsed) ? $parsed : $default;
}

/** Atomic write: temp file in the same directory, then rename over the target. */
function write_json_file($file, $data)
{
    $dir = dirname($file);
    if (!ensure_dir($dir)) {
        fail(500, 'Cannot create the data directory: ' . $dir);
    }
    $tmp = $file . '.' . getmypid() . '.tmp';
    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false || @file_put_contents($tmp, $json) === false) {
        @unlink($tmp);
        fail(500, 'Could not write ' . basename($file) . '. Check directory permissions.');
    }
    if (!@rename($tmp, $file)) {
        @unlink($tmp);
        fail(500, 'Could not replace ' . basename($file) . '.');
    }
    return true;
}

/** Keep the last OMGBB_BACKUPS copies of a file before overwriting it. */
function backup_file($file)
{
    if (!is_file($file)) {
        return;
    }
    $dir = data_dir() . '/backups';
    if (!ensure_dir($dir)) {
        return;
    }
    $base = basename($file, '.json');
    $stamp = gmdate('Y-m-d\TH-i-s') . 'Z';
    @copy($file, $dir . '/' . $base . '-' . $stamp . '.json');

    $existing = glob($dir . '/' . $base . '-*.json');
    if ($existing === false) {
        return;
    }
    rsort($existing);
    foreach (array_slice($existing, OMGBB_BACKUPS) as $stale) {
        @unlink($stale);
    }
}

function read_request_body()
{
    $raw = file_get_contents('php://input');
    if ($raw === false) {
        fail(400, 'Could not read the request body.');
    }
    if (strlen($raw) > OMGBB_MAX_BODY) {
        fail(413, 'Request body too large.');
    }
    return $raw;
}

function is_write_request($method)
{
    return $method === 'POST' || $method === 'PUT';
}

// ---------------------------------------------------------------- wiki proxy

/**
 * Serialise upstream calls and space them out. The lock is held across the
 * sleep, so two concurrent requests queue up instead of firing together.
 */
function throttle(&$handle)
{
    $file = data_dir() . '/wiki-state.json';
    ensure_dir(dirname($file));
    $handle = @fopen($file, 'c+');
    if (!$handle) {
        return array(true, 0); // storage problem: do not block the request
    }
    flock($handle, LOCK_EX);

    $raw = stream_get_contents($handle);
    $state = json_decode($raw ? $raw : '', true);
    if (!is_array($state)) {
        $state = array('lastAt' => 0, 'recent' => array(), 'total' => 0);
    }

    $now = microtime(true) * 1000;
    $cutoff = $now - 3600000;
    $recent = array();
    foreach ($state['recent'] as $timestamp) {
        if ($timestamp > $cutoff) {
            $recent[] = $timestamp;
        }
    }
    $left = OMGBB_HOURLY_BUDGET - count($recent);
    if ($left <= 0) {
        $state['recent'] = $recent;
        save_state($handle, $state);
        return array(false, 0);
    }

    $wait = OMGBB_MIN_GAP_MS - ($now - $state['lastAt']);
    if ($wait > 0 && $wait <= OMGBB_MIN_GAP_MS) {
        usleep((int) ($wait * 1000));
    }

    $now = microtime(true) * 1000;
    $recent[] = $now;
    $state['recent'] = $recent;
    $state['lastAt'] = $now;
    $state['total'] = (isset($state['total']) ? $state['total'] : 0) + 1;
    save_state($handle, $state);
    return array(true, $left - 1);
}

function save_state($handle, $state)
{
    ftruncate($handle, 0);
    rewind($handle);
    fwrite($handle, json_encode($state, JSON_UNESCAPED_SLASHES));
    fflush($handle);
}

function release_lock($handle)
{
    if ($handle) {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

function budget_left()
{
    $state = read_json_file(data_dir() . '/wiki-state.json', array('recent' => array()));
    $cutoff = microtime(true) * 1000 - 3600000;
    $count = 0;
    foreach ($state['recent'] as $timestamp) {
        if ($timestamp > $cutoff) {
            $count++;
        }
    }
    return OMGBB_HOURLY_BUDGET - $count;
}

/** GET a URL with curl, falling back to the stream wrapper. */
function http_get($url)
{
    if (function_exists('curl_init')) {
        $curl = curl_init($url);
        curl_setopt_array($curl, array(
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 3,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_USERAGENT => OMGBB_USER_AGENT,
            CURLOPT_HTTPHEADER => array('Accept: application/json'),
        ));
        $body = curl_exec($curl);
        $status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $error = curl_error($curl);
        curl_close($curl);
        if ($body === false) {
            return array(null, 'curl: ' . $error);
        }
        if ($status < 200 || $status >= 300) {
            return array(null, 'wiki responded HTTP ' . $status);
        }
        return array($body, null);
    }

    if (ini_get('allow_url_fopen')) {
        $context = stream_context_create(array('http' => array(
            'method' => 'GET',
            'timeout' => 20,
            'header' => "Accept: application/json\r\nUser-Agent: " . OMGBB_USER_AGENT . "\r\n",
        )));
        $body = @file_get_contents($url, false, $context);
        if ($body === false) {
            return array(null, 'request failed (allow_url_fopen)');
        }
        return array($body, null);
    }

    return array(null, 'This server has neither the curl extension nor allow_url_fopen enabled.');
}

function handle_wiki()
{
    global $ALLOWED_PARAMS, $ALLOWED_ACTIONS;

    $params = array();
    foreach ($ALLOWED_PARAMS as $key) {
        if (isset($_GET[$key]) && is_string($_GET[$key])) {
            $params[$key] = $_GET[$key];
        }
    }
    $action = isset($params['action']) ? $params['action'] : '';
    if (!in_array($action, $ALLOWED_ACTIONS, true)) {
        fail(400, 'action "' . $action . '" is not allowed');
    }
    $params['format'] = 'json';
    if ($action !== 'opensearch') {
        $params['formatversion'] = '2';
    }

    // Cache key matches server.js exactly, so a cache built by either backend
    // works for the other.
    ksort($params);
    $pairs = array();
    foreach ($params as $key => $value) {
        $pairs[] = array($key, $value);
    }
    $key = sha1(json_encode($pairs, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));

    $cacheDir = data_dir() . '/wiki-cache';
    $cacheFile = $cacheDir . '/' . $key . '.json';
    $fresh = isset($_GET['fresh']) && $_GET['fresh'] === '1';

    if (!$fresh && is_file($cacheFile)) {
        $cached = read_json_file($cacheFile, null);
        if (is_array($cached) && isset($cached['data'])) {
            send_json(200, array(
                'cached' => true,
                'fetchedAt' => isset($cached['fetchedAt']) ? $cached['fetchedAt'] : null,
                'data' => $cached['data'],
            ));
        }
    }

    $handle = null;
    list($allowed, $left) = throttle($handle);
    if (!$allowed) {
        release_lock($handle);
        fail(429, 'Hourly wiki budget of ' . OMGBB_HOURLY_BUDGET . ' requests is used up. ' .
            'Cached pages still work; try again later.');
    }

    $target = OMGBB_WIKI_API . '?' . http_build_query($params);
    list($body, $error) = http_get($target);
    release_lock($handle);

    if ($body === null) {
        fail(502, 'Wiki request failed: ' . $error);
    }
    $payload = json_decode($body, true);
    if (!is_array($payload)) {
        fail(502, 'Wiki returned a response that was not JSON.');
    }

    $record = array(
        'url' => $target,
        'fetchedAt' => gmdate('c'),
        'data' => $payload,
    );
    if (ensure_dir($cacheDir)) {
        $tmp = $cacheFile . '.' . getmypid() . '.tmp';
        if (@file_put_contents($tmp, json_encode($record, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)) !== false) {
            @rename($tmp, $cacheFile);
        } else {
            @unlink($tmp);
        }
    }

    send_json(200, array(
        'cached' => false,
        'fetchedAt' => $record['fetchedAt'],
        'data' => $payload,
    ));
}

// ---------------------------------------------------------------- accounts

/*
 * Crude but not careless: passwords are PBKDF2-SHA256 with a per-user salt,
 * compared in constant time. Sessions are random tokens held in an HttpOnly
 * cookie. server.js implements the identical scheme, so users.json and
 * sessions.json are portable between the Node and PHP backends.
 */

define('OMGBB_COOKIE', 'omgbb_session');
define('OMGBB_SESSION_DAYS', 30);
define('OMGBB_PBKDF2_ITER', 120000);
define('OMGBB_MAX_FAILURES', 5);
define('OMGBB_LOCKOUT_MIN', 15);

function users_file()
{
    return data_dir() . '/users.json';
}

function sessions_file()
{
    return data_dir() . '/sessions.json';
}

function load_users()
{
    $doc = read_json_file(users_file(), array(
        'schema' => 1, 'allowRegistration' => true, 'users' => array(),
    ));
    if (!isset($doc['users']) || !is_array($doc['users'])) {
        $doc['users'] = array();
    }
    return $doc;
}

/* Sessions and failures are lists, so they never round-trip as {} versus []. */
function load_sessions()
{
    $doc = read_json_file(sessions_file(), array('schema' => 1, 'sessions' => array(), 'failures' => array()));
    foreach (array('sessions', 'failures') as $key) {
        if (!isset($doc[$key]) || !is_array($doc[$key])) {
            $doc[$key] = array();
        }
    }
    return $doc;
}

function hash_password($password)
{
    $salt = bin2hex(random_bytes(16));
    $key = hash_pbkdf2('sha256', $password, hex2bin($salt), OMGBB_PBKDF2_ITER, 64, false);
    return 'pbkdf2$sha256$' . OMGBB_PBKDF2_ITER . '$' . $salt . '$' . $key;
}

function verify_password($password, $stored)
{
    $parts = explode('$', (string) $stored);
    if (count($parts) !== 5 || $parts[0] !== 'pbkdf2' || $parts[1] !== 'sha256') {
        return false;
    }
    $iterations = (int) $parts[2];
    $salt = $parts[3];
    $expected = $parts[4];
    if ($iterations < 1000 || !ctype_xdigit($salt) || !ctype_xdigit($expected)) {
        return false;
    }
    $key = hash_pbkdf2('sha256', $password, hex2bin($salt), $iterations, strlen($expected), false);
    return hash_equals($expected, $key);
}

function cookie_path()
{
    $dir = isset($_SERVER['SCRIPT_NAME']) ? dirname($_SERVER['SCRIPT_NAME']) : '/';
    $dir = str_replace('\\', '/', $dir);
    if ($dir === '' || $dir === '.') {
        $dir = '/';
    }
    if (substr($dir, -1) !== '/') {
        $dir .= '/';
    }
    return $dir;
}

function is_https()
{
    if (!empty($_SERVER['HTTPS']) && strtolower($_SERVER['HTTPS']) !== 'off') {
        return true;
    }
    return isset($_SERVER['HTTP_X_FORWARDED_PROTO'])
        && strtolower($_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https';
}

function set_session_cookie($token, $expires)
{
    $path = cookie_path();
    if (PHP_VERSION_ID >= 70300) {
        setcookie(OMGBB_COOKIE, $token, array(
            'expires' => $expires,
            'path' => $path,
            'secure' => is_https(),
            'httponly' => true,
            'samesite' => 'Lax',
        ));
        return;
    }
    // Older PHP has no samesite option; smuggle it through the path argument.
    setcookie(OMGBB_COOKIE, $token, $expires, $path . '; samesite=Lax', '', is_https(), true);
}

function prune_sessions($doc)
{
    $now = time();
    $live = array();
    foreach ($doc['sessions'] as $session) {
        if (isset($session['expiresAt']) && $session['expiresAt'] > $now) {
            $live[] = $session;
        }
    }
    $doc['sessions'] = $live;

    $failures = array();
    foreach ($doc['failures'] as $failure) {
        if (isset($failure['until']) && $failure['until'] > $now) {
            $failures[] = $failure;
        }
    }
    $doc['failures'] = $failures;
    return $doc;
}

function start_session_for($userId)
{
    $token = bin2hex(random_bytes(32));
    $expires = time() + OMGBB_SESSION_DAYS * 86400;
    $doc = prune_sessions(load_sessions());
    $doc['sessions'][] = array('token' => $token, 'userId' => $userId, 'expiresAt' => $expires);
    write_json_file(sessions_file(), $doc);
    set_session_cookie($token, $expires);
}

function current_user()
{
    static $resolved = false;
    static $user = null;
    if ($resolved) {
        return $user;
    }
    $resolved = true;

    $token = isset($_COOKIE[OMGBB_COOKIE]) ? (string) $_COOKIE[OMGBB_COOKIE] : '';
    if ($token === '') {
        return null;
    }
    $now = time();
    $userId = null;
    $sessions = load_sessions();
    foreach ($sessions['sessions'] as $session) {
        if (isset($session['token'], $session['expiresAt'])
            && hash_equals((string) $session['token'], $token)
            && $session['expiresAt'] > $now) {
            $userId = $session['userId'];
            break;
        }
    }
    if ($userId === null) {
        return null;
    }
    $users = load_users();
    foreach ($users['users'] as $candidate) {
        if ($candidate['id'] === $userId) {
            $user = $candidate;
            break;
        }
    }
    return $user;
}

function public_user($user)
{
    if (!$user) {
        return null;
    }
    return array(
        'id' => $user['id'],
        'username' => $user['username'],
        'owner' => !empty($user['owner']),
    );
}

/** Crude brute-force brake: five bad tries park that username for a while. */
function lockout_remaining($username)
{
    $now = time();
    $doc = load_sessions();
    foreach ($doc['failures'] as $failure) {
        if ($failure['username'] === $username
            && $failure['count'] >= OMGBB_MAX_FAILURES
            && $failure['until'] > $now) {
            return (int) ceil(($failure['until'] - $now) / 60);
        }
    }
    return 0;
}

function record_failure($username)
{
    $doc = prune_sessions(load_sessions());
    $found = false;
    foreach ($doc['failures'] as $i => $failure) {
        if ($failure['username'] === $username) {
            $doc['failures'][$i]['count'] = $failure['count'] + 1;
            $doc['failures'][$i]['until'] = time() + OMGBB_LOCKOUT_MIN * 60;
            $found = true;
            break;
        }
    }
    if (!$found) {
        $doc['failures'][] = array(
            'username' => $username,
            'count' => 1,
            'until' => time() + OMGBB_LOCKOUT_MIN * 60,
        );
    }
    write_json_file(sessions_file(), $doc);
}

function clear_failures($username)
{
    $doc = prune_sessions(load_sessions());
    $kept = array();
    foreach ($doc['failures'] as $failure) {
        if ($failure['username'] !== $username) {
            $kept[] = $failure;
        }
    }
    $doc['failures'] = $kept;
    write_json_file(sessions_file(), $doc);
}

function credentials_from_body()
{
    $body = json_decode(read_request_body(), true);
    if (!is_array($body)) {
        fail(400, 'expected a JSON object');
    }
    $username = isset($body['username']) ? trim((string) $body['username']) : '';
    $password = isset($body['password']) ? (string) $body['password'] : '';
    return array($username, $password);
}

function handle_auth($route, $method)
{
    $usersDoc = load_users();
    $needsSetup = count($usersDoc['users']) === 0;

    if ($route === 'me') {
        $user = current_user();
        send_json(200, array(
            'authenticated' => (bool) $user,
            'user' => public_user($user),
            'needsSetup' => $needsSetup,
            'registrationOpen' => $needsSetup || !empty($usersDoc['allowRegistration']),
        ));
    }

    if ($route === 'logout') {
        $token = isset($_COOKIE[OMGBB_COOKIE]) ? (string) $_COOKIE[OMGBB_COOKIE] : '';
        if ($token !== '') {
            $doc = prune_sessions(load_sessions());
            $kept = array();
            foreach ($doc['sessions'] as $session) {
                if (!hash_equals((string) $session['token'], $token)) {
                    $kept[] = $session;
                }
            }
            $doc['sessions'] = $kept;
            write_json_file(sessions_file(), $doc);
        }
        set_session_cookie('', time() - 3600);
        send_json(200, array('ok' => true));
    }

    if (!is_write_request($method)) {
        fail(405, 'method not allowed');
    }

    if ($route === 'register') {
        if (!$needsSetup && empty($usersDoc['allowRegistration'])) {
            fail(403, 'Registration is closed on this site.');
        }
        list($username, $password) = credentials_from_body();
        if (!preg_match('/^[A-Za-z0-9._-]{3,32}$/', $username)) {
            fail(400, 'Username must be 3-32 characters: letters, digits, dot, dash or underscore.');
        }
        if (strlen($password) < 8) {
            fail(400, 'Password must be at least 8 characters.');
        }
        foreach ($usersDoc['users'] as $existing) {
            if (strcasecmp($existing['username'], $username) === 0) {
                fail(409, 'That username is taken.');
            }
        }
        $user = array(
            'id' => 'u' . bin2hex(random_bytes(8)),
            'username' => $username,
            'hash' => hash_password($password),
            'owner' => $needsSetup,
            'createdAt' => gmdate('c'),
        );
        $usersDoc['users'][] = $user;
        if ($needsSetup) {
            // The first account owns the site; nobody else joins unless invited.
            $usersDoc['allowRegistration'] = false;
        }
        backup_file(users_file());
        write_json_file(users_file(), $usersDoc);
        start_session_for($user['id']);
        send_json(200, array(
            'ok' => true,
            'user' => public_user($user),
            'registrationOpen' => !empty($usersDoc['allowRegistration']),
        ));
    }

    if ($route === 'login') {
        list($username, $password) = credentials_from_body();
        $key = strtolower($username);
        $locked = lockout_remaining($key);
        if ($locked > 0) {
            fail(429, 'Too many attempts. Try again in ' . $locked . ' minute(s).');
        }
        foreach ($usersDoc['users'] as $candidate) {
            if (strcasecmp($candidate['username'], $username) === 0
                && verify_password($password, $candidate['hash'])) {
                clear_failures($key);
                start_session_for($candidate['id']);
                send_json(200, array(
                    'ok' => true,
                    'user' => public_user($candidate),
                    'registrationOpen' => !empty($usersDoc['allowRegistration']),
                ));
            }
        }
        record_failure($key);
        fail(401, 'Wrong username or password.');
    }

    if ($route === 'settings') {
        $user = current_user();
        if (!$user || empty($user['owner'])) {
            fail(403, 'Only the site owner can change this.');
        }
        $body = json_decode(read_request_body(), true);
        if (!is_array($body) || !array_key_exists('allowRegistration', $body)) {
            fail(400, 'expected {"allowRegistration": true|false}');
        }
        $usersDoc['allowRegistration'] = (bool) $body['allowRegistration'];
        write_json_file(users_file(), $usersDoc);
        send_json(200, array('ok' => true, 'registrationOpen' => $usersDoc['allowRegistration']));
    }

    fail(404, 'unknown route');
}

// ------------------------------------------------------------ JSON documents

/*
 * Shelves and the catalogue travel as documents, never as PHP arrays: PHP
 * cannot tell an empty JSON object from an empty list, and turning {} into []
 * makes the browser silently drop everything later stored in that map.
 */

function send_document($file, $default)
{
    $raw = is_file($file) ? @file_get_contents($file) : false;
    if ($raw === false || $raw === '' || !is_object(json_decode($raw))) {
        send_json(200, $default);
    }
    http_response_code(200);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo $raw;
    exit;
}

function decode_document($raw)
{
    $parsed = json_decode($raw);
    if (!is_object($parsed)) {
        fail(400, 'expected a JSON object');
    }
    return $parsed;
}

// ------------------------------------------------------- document operations

/*
 * Shelves and the catalogue are never uploaded whole. The browser sends small
 * operations and the server applies them to the current file under a lock:
 * requests stay a few kilobytes - well below shared-host body limits - and two
 * tabs, or a tab running an older version of the app, cannot overwrite each
 * other. server.js implements the identical protocol.
 */

define('OMGBB_API_VERSION', 3);
define('OMGBB_MAX_OPS', 200);
define('OMGBB_ENTRY_ID', '/^[A-Za-z0-9_-]{1,64}$/');
define('OMGBB_PART_KEY', '/^[A-Za-z]{1,20}:[a-z0-9]{0,80}$/');
define('OMGBB_PART_KIND', '/^[A-Za-z]{1,20}$/');

function read_document($file)
{
    $raw = is_file($file) ? @file_get_contents($file) : false;
    $doc = ($raw === false || $raw === '') ? null : json_decode($raw);
    return is_object($doc) ? $doc : null;
}

/** Run $task alone for this file. The lock is released when the request ends at the latest. */
function with_file_lock($file, $task)
{
    ensure_dir(dirname($file));
    $handle = @fopen($file . '.lock', 'c');
    if (!$handle) {
        fail(500, 'Could not lock ' . basename($file) . '. Check directory permissions.');
    }
    flock($handle, LOCK_EX);
    try {
        return $task();
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

function read_ops()
{
    $body = json_decode(read_request_body());
    if (!is_object($body)) {
        fail(400, 'expected a JSON object');
    }
    if (!isset($body->ops) || !is_array($body->ops)) {
        // A whole document: an open tab still running an older version of the app.
        send_json(409, array(
            'error' => 'This page is running an older version of the app. Reload it to keep saving.',
            'code' => 'stale-client',
        ));
    }
    $count = count($body->ops);
    if ($count < 1 || $count > OMGBB_MAX_OPS) {
        fail(400, 'expected 1 to ' . OMGBB_MAX_OPS . ' operations');
    }
    return $body->ops;
}

function apply_shelf_ops($doc, $ops)
{
    if (!is_object($doc)) {
        $doc = new stdClass();
        $doc->schema = 1;
    }
    if (!isset($doc->beyblades) || !is_array($doc->beyblades)) {
        $doc->beyblades = array();
    }
    if (!isset($doc->combos) || !is_array($doc->combos)) {
        $doc->combos = array();
    }
    if (!isset($doc->parts) || !is_object($doc->parts)) {
        $doc->parts = new stdClass();
    }

    foreach ($ops as $op) {
        if (!is_object($op) || !isset($op->op)) {
            fail(400, 'Each operation must be an object.');
        }
        if ($op->op === 'putEntry') {
            if (!isset($op->entry) || !is_object($op->entry) || !isset($op->entry->id)
                || !preg_match(OMGBB_ENTRY_ID, (string) $op->entry->id)) {
                fail(400, 'putEntry needs an entry with an id.');
            }
            $found = false;
            foreach ($doc->beyblades as $i => $existing) {
                if (is_object($existing) && isset($existing->id) && $existing->id === $op->entry->id) {
                    $doc->beyblades[$i] = $op->entry;
                    $found = true;
                    break;
                }
            }
            if (!$found) {
                $doc->beyblades[] = $op->entry;
            }
        } elseif ($op->op === 'removeEntry') {
            if (!isset($op->id) || !preg_match(OMGBB_ENTRY_ID, (string) $op->id)) {
                fail(400, 'removeEntry needs an id.');
            }
            $kept = array();
            foreach ($doc->beyblades as $existing) {
                if (!(is_object($existing) && isset($existing->id) && $existing->id === $op->id)) {
                    $kept[] = $existing;
                }
            }
            $doc->beyblades = $kept;
        } elseif ($op->op === 'putPart') {
            if (!isset($op->key) || !preg_match(OMGBB_PART_KEY, (string) $op->key)
                || !isset($op->part) || !is_object($op->part)) {
                fail(400, 'putPart needs a part key and a part.');
            }
            $doc->parts->{$op->key} = $op->part;
        } elseif ($op->op === 'putCombo') {
            if (!isset($op->combo) || !is_object($op->combo) || !isset($op->combo->id)
                || !preg_match(OMGBB_ENTRY_ID, (string) $op->combo->id)) {
                fail(400, 'putCombo needs a combo with an id.');
            }
            $found = false;
            foreach ($doc->combos as $i => $existing) {
                if (is_object($existing) && isset($existing->id) && $existing->id === $op->combo->id) {
                    $doc->combos[$i] = $op->combo;
                    $found = true;
                    break;
                }
            }
            if (!$found) {
                $doc->combos[] = $op->combo;
            }
        } elseif ($op->op === 'removeCombo') {
            if (!isset($op->id) || !preg_match(OMGBB_ENTRY_ID, (string) $op->id)) {
                fail(400, 'removeCombo needs an id.');
            }
            $kept = array();
            foreach ($doc->combos as $existing) {
                if (!(is_object($existing) && isset($existing->id) && $existing->id === $op->id)) {
                    $kept[] = $existing;
                }
            }
            $doc->combos = $kept;
        } elseif ($op->op === 'replace') {
            if (!isset($op->doc) || !is_object($op->doc) || !isset($op->doc->beyblades)
                || !is_array($op->doc->beyblades)) {
                fail(400, 'replace needs a shelf document.');
            }
            $current = isset($doc->revision) ? (int) $doc->revision : 0;
            $base = isset($op->baseRevision) ? (int) $op->baseRevision : -1;
            if ($base !== $current) {
                send_json(409, array(
                    'error' => 'The shelf changed since this page loaded it. Reload, then import again.',
                    'code' => 'conflict',
                ));
            }
            $doc = $op->doc;
            $doc->revision = $current;
            if (!isset($doc->parts) || !is_object($doc->parts)) {
                $doc->parts = new stdClass();
            }
            if (!isset($doc->combos) || !is_array($doc->combos)) {
                $doc->combos = array();
            }
        } else {
            fail(400, 'Unknown operation "' . (string) $op->op . '".');
        }
    }
    return $doc;
}

function apply_index_ops($doc, $ops)
{
    if (!is_object($doc)) {
        $doc = new stdClass();
    }
    if (!isset($doc->categories) || !is_object($doc->categories)) {
        $doc->categories = new stdClass();
    }

    foreach ($ops as $op) {
        if (!is_object($op) || !isset($op->op)) {
            fail(400, 'Each operation must be an object.');
        }
        if ($op->op === 'setCategory') {
            if (!isset($op->kind) || !preg_match(OMGBB_PART_KIND, (string) $op->kind)
                || !isset($op->items) || !is_array($op->items)) {
                fail(400, 'setCategory needs a kind and a list of items.');
            }
            $doc->categories->{$op->kind} = $op->items;
        } elseif ($op->op === 'setProducts') {
            $start = isset($op->start) ? $op->start : null;
            $total = isset($op->total) ? $op->total : null;
            if (!is_int($start) || $start < 0 || !is_int($total) || $total < 0
                || !isset($op->items) || !is_array($op->items)) {
                fail(400, 'setProducts needs start, total and items.');
            }
            $existing = (isset($doc->products) && is_array($doc->products)) ? $doc->products : array();
            if ($start > count($existing)) {
                send_json(409, array('error' => 'Catalogue pieces arrived out of order. Sync again.', 'code' => 'conflict'));
            }
            $doc->products = array_slice(array_merge(array_slice($existing, 0, $start), $op->items), 0, $total);
        } elseif ($op->op === 'finish') {
            if (!isset($op->productsTotal) || !is_int($op->productsTotal)) {
                fail(400, 'finish needs productsTotal.');
            }
            $doc->schema = (isset($op->schema) && is_int($op->schema)) ? $op->schema : 2;
            $doc->productsTotal = $op->productsTotal;
            $doc->catalogueUpdatedAt = (isset($op->catalogueUpdatedAt) && is_string($op->catalogueUpdatedAt))
                ? $op->catalogueUpdatedAt
                : gmdate('c');
        } else {
            fail(400, 'Unknown operation "' . (string) $op->op . '".');
        }
    }
    return $doc;
}

// ------------------------------------------------------------------ shelves

/*
 * Each account owns a shelf: data/collections/<userId>.json. Any signed-in
 * blader may read another shelf; writes always land on the session user's own,
 * whatever the request asks for.
 */

function collections_dir()
{
    return data_dir() . '/collections';
}

function collection_file($userId)
{
    return collections_dir() . '/' . $userId . '.json';
}

function legacy_collection_file()
{
    return data_dir() . '/collection.json';
}

/** The single pre-accounts collection becomes the owner's shelf, once. */
function adopt_legacy_collection($user)
{
    if (empty($user['owner'])) {
        return;
    }
    $target = collection_file($user['id']);
    if (is_file($target) || !is_file(legacy_collection_file())) {
        return;
    }
    if (ensure_dir(collections_dir())) {
        @rename(legacy_collection_file(), $target);
    }
}

function empty_collection()
{
    return array(
        'schema' => 1, 'updatedAt' => null, 'beyblades' => array(),
        'parts' => new stdClass(), 'combos' => array(),
    );
}

function find_user($userId)
{
    $users = load_users();
    foreach ($users['users'] as $candidate) {
        if ($candidate['id'] === $userId) {
            return $candidate;
        }
    }
    return null;
}

/** Headline numbers for the blader list, cheap enough to compute on the fly. */
function summarise_collection($doc)
{
    $beys = isset($doc['beyblades']) && is_array($doc['beyblades']) ? $doc['beyblades'] : array();
    $units = 0;
    $partKeys = array();
    $types = array();
    $wishlist = 0;
    foreach ($beys as $bey) {
        // Wishlist entries are wants, not holdings: count them apart.
        if (isset($bey['status']) && $bey['status'] === 'wish') {
            $wishlist++;
            continue;
        }
        $qty = isset($bey['qty']) ? (int) $bey['qty'] : 1;
        if ($qty < 1) {
            $qty = 1;
        }
        $units += $qty;
        if (isset($bey['partKeys']) && is_array($bey['partKeys'])) {
            foreach ($bey['partKeys'] as $key) {
                $partKeys[$key] = true;
            }
        }
        $type = isset($bey['bey']['type']) ? $bey['bey']['type'] : null;
        if ($type) {
            $types[$type] = (isset($types[$type]) ? $types[$type] : 0) + $qty;
        }
    }
    $topType = null;
    $best = 0;
    foreach ($types as $type => $count) {
        if ($count > $best) {
            $best = $count;
            $topType = $type;
        }
    }
    return array(
        'products' => count($beys) - $wishlist,
        'wishlist' => $wishlist,
        'units' => $units,
        'uniqueParts' => count($partKeys),
        'combos' => (isset($doc['combos']) && is_array($doc['combos'])) ? count($doc['combos']) : 0,
        'topType' => $topType,
        'updatedAt' => isset($doc['updatedAt']) ? $doc['updatedAt'] : null,
    );
}

function handle_users()
{
    $users = load_users();
    $list = array();
    foreach ($users['users'] as $account) {
        adopt_legacy_collection($account);
        $doc = read_json_file(collection_file($account['id']), array());
        $list[] = array(
            'id' => $account['id'],
            'username' => $account['username'],
            'owner' => !empty($account['owner']),
            'createdAt' => isset($account['createdAt']) ? $account['createdAt'] : null,
            'stats' => summarise_collection($doc),
        );
    }
    send_json(200, array('users' => $list));
}

function handle_collection($method)
{
    $me = current_user();

    if ($method === 'GET') {
        $wanted = isset($_GET['user']) ? (string) $_GET['user'] : '';
        $target = ($wanted === '' || $wanted === $me['id']) ? $me : find_user($wanted);
        if (!$target) {
            fail(404, 'No blader by that id.');
        }
        adopt_legacy_collection($target);
        send_document(collection_file($target['id']), empty_collection());
    }

    if (is_write_request($method)) {
        // Deliberately ignores any ?user= - you can only write your own shelf.
        adopt_legacy_collection($me);
        $ops = read_ops();
        $file = collection_file($me['id']);
        ensure_dir(collections_dir());
        $result = with_file_lock($file, function () use ($file, $ops) {
            $current = read_document($file);
            $revision = ($current && isset($current->revision)) ? (int) $current->revision : 0;
            $doc = apply_shelf_ops($current, $ops);
            $doc->revision = $revision + 1;
            $doc->updatedAt = gmdate('c');
            backup_file($file);
            write_json_file($file, $doc);
            return array('ok' => true, 'revision' => $doc->revision, 'updatedAt' => $doc->updatedAt);
        });
        send_json(200, $result);
    }

    fail(405, 'method not allowed');
}

// -------------------------------------------------------------------- routing

$route = isset($_GET['route']) ? $_GET['route'] : '';
$method = isset($_SERVER['REQUEST_METHOD']) ? strtoupper($_SERVER['REQUEST_METHOD']) : 'GET';
header('X-OMGBB-Api: ' . OMGBB_API_VERSION);

$files = array(
    'index' => 'part-index.json',
);
$defaults = array(
    'index' => array('schema' => 1, 'updatedAt' => null, 'categories' => new stdClass()),
);

if (in_array($route, array('me', 'login', 'logout', 'register', 'settings'), true)) {
    handle_auth($route, $method);
}

if ($route === 'status') {
    // Deliberately reachable without a session so a deployment can be checked.
    // Anything that would leak server paths or activity needs one.
    $dir = data_dir();
    $signedIn = (bool) current_user();
    $payload = array(
        'ok' => true,
        'backend' => 'php',
        'phpVersion' => PHP_VERSION,
        'dataDirWritable' => is_dir($dir) && is_writable($dir),
        'httpClient' => function_exists('curl_init') ? 'curl' : (ini_get('allow_url_fopen') ? 'stream' : 'none'),
        'authenticated' => $signedIn,
    );
    if ($signedIn) {
        $cacheDir = $dir . '/wiki-cache';
        $cached = is_dir($cacheDir) ? glob($cacheDir . '/*.json') : array();
        $payload['dataDir'] = $dir;
        $payload['cachedPages'] = $cached === false ? 0 : count($cached);
        $payload['hourlyBudgetLeft'] = budget_left();
    }
    send_json(200, $payload);
}

// Everything past this point is private.
if (!current_user()) {
    fail(401, 'Sign in first.');
}

if ($route === 'wiki') {
    if ($method !== 'GET') {
        fail(405, 'method not allowed');
    }
    handle_wiki();
}

if ($route === 'collection') {
    handle_collection($method);
}

if ($route === 'users') {
    if ($method !== 'GET') {
        fail(405, 'method not allowed');
    }
    handle_users();
}

if (isset($files[$route])) {
    $file = data_dir() . '/' . $files[$route];

    if ($method === 'GET') {
        send_document($file, $defaults[$route]);
    }

    if (is_write_request($method)) {
        $ops = read_ops();
        $result = with_file_lock($file, function () use ($file, $ops) {
            $doc = apply_index_ops(read_document($file), $ops);
            $doc->updatedAt = gmdate('c');
            backup_file($file);
            write_json_file($file, $doc);
            return array('ok' => true, 'updatedAt' => $doc->updatedAt);
        });
        send_json(200, $result);
    }

    fail(405, 'method not allowed');
}

fail(404, 'unknown route "' . $route . '"');
