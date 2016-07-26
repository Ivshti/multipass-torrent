var Stremio = require("stremio-addons");
var http = require("http");
var _ = require("lodash");
var async = require("async");
var sift = require("sift");
var bagpipe = require("bagpipe");
var events = require("events");

module.exports = function(db, utils, cfg) {

// Keeping meta collection up to date; Algo here is
// async.queue with concurrency = 1 / bagpipe(1) ; we push update requests and collectMeta() calls to it 
// updateMeta() function, called on idxbuild, debounced at half a second (or 300ms?)
// sample test: 79.1mb / 74.8mb / 75.1mb RAM with 1000 lean meta ; without: 72.0mb, 74.4, 72.3 NO DIFF in memory usage
var LID = cfg.LID || cfg.dbId.slice(0, 10);
var metaQueryProps = ["imdb_id", "type", "name", "year", "genre", "director", "dvdRelease", "imdbRating", "poster", "popularities."+LID];


var CINEMETA_URL = process.env.CINEMETA || cfg.cinemeta || "http://cinemeta.strem.io/stremioget";
var addons = new Stremio.Client();
addons.add(CINEMETA_URL);

var meta = { col: [], updated: 0, have: { } };
var metaPipe = new bagpipe(1);

var lastPopularities;

function updateMeta(ready) {
    db.popularities(function(err, popularities) {
        lastPopularities = popularities;

        var popSort = function(x) { return -popularities[x.imdb_id || x] };
        var constructMeta = function(x) {
            x.imdbRating = parseFloat(x.imdbRating);
            x.popularities = { }; // reset that - don't know if it brings any benefits
            x.popularities[LID] = popularities[x.imdb_id] || 0;
            x.isPeered = !!popularities[x.imdb_id];
            // figure out year? since for series it's like "2011-2015" we can sort by the first field, but we can't replace the value
            meta.have[x.imdb_id] = 1;
        };

        var toGet = [];
        Object.keys(popularities).forEach(function(k) { if (! meta.have[k]) toGet.push(k) });
        toGet = toGet.filter(function(x) { return x && x.match("^tt") });
        toGet = toGet.sort(function(a, b) { return (popularities[b] || 0) - (popularities[a] || 0) });
        toGet = toGet.slice(0, 500);

        if (toGet.length == 0) return process.nextTick(ready);

        addons.meta.find({ query: { imdb_id: { $in: toGet } }, limit: toGet.length }, function(err, res) {
            process.nextTick(ready); // ensure we don't dead-end (deadlock is not a right term, block is not the right term, terms have to figured out for async code)
            if (err) console.error("meta.find from "+CINEMETA_URL, err);
            meta.ready = true;
            meta.col = _.chain(meta.col).concat(res || []).sortBy(popSort).uniq("imdb_id").each(constructMeta).value();
            db.evs.emit("catalogue-update", meta.col, popularities);
        });
    });
};

db.evs.on("idxbuild", _.debounce(function() { if (! metaPipe.queue.length) metaPipe.push(updateMeta) }, 1000));
db.evs.on("idxready", function() { metaPipe.push(updateMeta) });

// Basic validation of args
function validate(args) {
    var meta = args.query;
    if (! (args.query || args.infoHash)) return { code: 0, message: "query/infoHash required" };
    if (meta && !meta.imdb_id) return { code: 1, message: "imdb_id required" };
    if (meta && (meta.type == "series" && !(meta.hasOwnProperty("episode") && meta.hasOwnProperty("season"))))
        return { code: 2, message: "season and episode required for series type" };
    return false;
};

function query(args, callback) {
    var start = Date.now();

    (function(next) { 
        if (args.infoHash) return db.get(args.infoHash, function(err, res) { next(err, res && res[0] && res[0].value) });
        if (! args.query) return next(new Error("must specify query or infoHash"));

        //var preferred = _.uniq(PREFERRED.concat(args.preferred || []), function(x) { return x.tag });
        var preferred = args.preferred || [];
        var prio = function(resolution) {
            return preferred.map(function(pref) { 
                return utils.getAvailForTorrent(resolution.torrent) >= pref.min_avail && resolution.file && resolution.file.tag.indexOf(pref.tag)!=-1
            }).reduce(function(a,b) { return a+b }, 0);
        };

        var resolution = null;
        db.lookup(args.query, 3, function(err, matches) {
            if (err) return next(err);

            async.whilst(
                function() { return matches.length && (!resolution || prio(resolution) < preferred.length) },
                function(callback) {
                    var hash = matches.shift().id;
                    db.get(hash, function(err, res) {
                        if (err) return callback({ err: err });

                        var tor = res[0] && res[0].value;
                        if (! tor) return callback({ err: "hash not found "+hash });

                        var file = _.find(tor.files, function(f) { 
                            return f.imdb_id == args.query.imdb_id && 
                                (args.query.season ? (f.season == args.query.season) : true) &&
                                (args.query.episode ? ((f.episode || []).indexOf(args.query.episode) != -1) : true)
                        });
			
			// TODO: error when no file is found?
			
                        var res = { torrent: tor, file: file };
                        if (!resolution || prio(res) > prio(resolution)) resolution = res;

                        callback();
                    });
                },
                function(err) { resolution ? next(resolution.err, resolution.torrent, resolution.file) : next(err) }
            );
        });
    })(function(err, torrent, file) {
        // Output according to Stremio Addon API for stream.get
        // http://strem.io/addons-api
        callback(err, torrent ? _.extend({ 
            infoHash: torrent.infoHash.toLowerCase(), 
            uploaders: utils.getMaxPopularity(torrent), // optional
            downloaders: Math.max.apply(Math, _.values(torrent.popularity).map(function(x) { return x[1] }).concat(0)), // optional
            //map: torrent.files,
            //pieceLength: torrent.pieceLength,
            availability: utils.getAvailForTorrent(torrent),
            isFree: true,
            sources: utils.getSourcesForTorrent(torrent), // optional but preferred
            runtime: Date.now()-start // optional
        }, file ? { 
            mapIdx: file.idx,
            tag: file.tag, filename: file.name,
        } : { }) : null);
    });
};

var FILTER = _.object([ "sort.popularities."+LID,"query.popularities."+LID ], [{ "$exists": true },{ "$exists": true }]);
var FILTER_OVERRIDE_CINEMETA = _.extend(FILTER, { 
    "projection.imdb_id": {"$exists":true}, 
    "popular": {"$exists":true}, 
    "query.type": { $in: ["movie", "series"] },
});

var manifest = _.merge({ 
    // this should be always overridable by stremio-manifest
    stremio_LID: LID,
    // set filter so that we intercept meta.find from cinemeta
    filter: FILTER_OVERRIDE_CINEMETA,
}, require("./stremio-manifest"), _.pick(require("../package"), "version"), cfg.stremioManifest || {});

var methods;
var service = new Stremio.Server(methods = {
    "stream.get": function(args, callback, user) { // OBSOLETE
        service.events.emit("stream.get", args, callback); 

        var error = validate(args);
        if (error) return callback(error);
        query(args, callback);
    },
    "stream.find": function(args, callback, user) {
        service.events.emit("stream.find", args, callback);

        if (args.query) {
            // New format ; same as stream.get, even returns the full result; no point to slim it down, takes same time
            var error = validate(args);
            if (error) return callback(error);
            async.map([ _.extend({ preferred: [{ tag: "hd", min_avail: 2 }] }, args), args ], query, function(err, res) {
                if (err) return callback(err);
                if (! res) return callback(null, res);

                var results = _.chain(res).filter(function(x) { return x }).uniq(function(x) { return x.infoHash }).value();
                service.events.emit("stream.find.res", results);
                callback(null, results);
            });
        } else return callback({code: 10, message: "unsupported arguments"});
    },
    "stream.popularities": function(args, callback, user) { // OBSOLETE
        service.events.emit("stream.popularities", args, callback);
        db.popularities(function(err, popularities) { callback(err, popularities ? { popularities: popularities } : null) });
    },
    "meta.find": function(args, callback, user) {
        service.events.emit("meta.find", args, callback);

        var firstSort = Object.keys(args.sort || { })[0];
        if (firstSort !== "popularities."+LID) {
            addons.meta.find(args, function(err, res) {
                if (res && lastPopularities) res.forEach(function(x) { x.isPeered = !!lastPopularities[x.imdb_id] });
                callback(err, res);
            });
            return;
        }

        // Call this to wait for meta to be collected
        if (args.projection && ( args.projection=="full" ) ) return callback(new Error("full projection not supported by mp"));
         
        (meta.ready ? function(n) { n() } : metaPipe.push.bind(metaPipe))(function(ready) {
            if (typeof(ready) == "function") process.nextTick(ready); // ensure we don't lock 

            args.query = _.pick.apply(null, [args.query || { }].concat(metaQueryProps));
            args.sort = _.pick.apply(null, [args.sort || { }].concat(metaQueryProps));
            //if (! _.keys(args.sort).length) args.sort["popularities."+LID] = -1; // no need as this is our default sort order

            var proj, projFn;
            if (args.projection && typeof(args.projection) == "object") { 
                proj = _.keys(args.projection);
                projFn = _.values(args.projection)[0] ? _.pick : _.omit;
            }

            var res = _.chain(meta.col)
                .filter(args.query ? sift(args.query) : _.constant(true))
                .sortByOrder(_.keys(args.sort), _.values(args.sort).map(function(x) { return x>0 ? "asc" : "desc" }))
                .slice(args.skip || 0, Math.min(400, args.limit))
                .map(function(x) { return projFn ? projFn(x, proj) : x })
                .value();
            
            service.events.emit("meta.find.res", res);
            callback(null, res);
        });
    },
    "stats.get": function(args, callback, user) {
        service.events.emit("stats.get", args, callback);

        var items = 0, episodes = 0, movies = 0;
        db.forEachMeta(function(n) {
            if (n.key.indexOf(" ") != -1) episodes++; else movies++;
            items++;
        }, function() {
            db.count(function(err, c) {
                callback(null, { statsNum: items+" movies and episodes", stats: [
                    { name: "number of items - "+items, count: items, colour: items > 20 ? "green" : (items > 10 ? "yellow" : "red") },
                    { name: "number of movies - "+movies, count: movies, colour: movies > 20 ? "green" : (movies > 10 ? "yellow" : "red") },
                    { name: "number of episodes - "+episodes, count: episodes, colour: episodes > 20 ? "green" : (episodes > 10 ? "yellow" : "red") },
                    { name: "number of torrents - "+c, count: c, colour: c > 50 ? "green" : (c > 20 ? "yellow" : "red") }
                ] });
            });
        });
    },
}, { stremioget: true, allow: [cfg.stremioCentral,"http://api8.herokuapp.com","http://api9.strem.io","https://api9.strem.io"], secret: cfg.stremioSecret }, manifest);

// Event emitter in case we want to intercept/plug-in to this
service.events = new events.EventEmitter();

function listen(port, ip) {
    var server = http.createServer(function (req, res) {
	req.on("error", function(e) { console.error(e) });
        service.middleware(req, res, function() { res.end() });
    })
    .on("error", function(e) { console.error("mp server", e) })
    .on("listening", function()
    {
        console.log("Multipass Stremio Addon listening on "+server.address().port);
    });
    return server.listen(port, ip);
}

module.exports.service = service;
module.exports.methods = methods;
return listen;

}
