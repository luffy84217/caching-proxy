#!/usr/bin/env node

const { Command } = require('commander');
const CachingProxy = require('../lib/caching-proxy');

const program = new Command();

program
    .name('caching-proxy')
    .description('A CLI tool for starting a caching proxy server')
    .version('1.0.0')

program
    .option('-p, --port <number>', 'port number for the proxy server')
    .option('-o, --origin <url>', 'origin server URL to proxy requests to')
    .action(async (options) => {
        // Validate required options
        if (!options.port || !options.origin) {
            console.error('❌ Error: Both --port and --origin are required');
            console.log('\nExample: caching-proxy --port 3000 --origin https://dummyjson.com');
            console.log('Run "caching-proxy --help" for more information');
            process.exit(1);
        }

        // Validate port
        const port = parseInt(options.port);
        if (isNaN(port) || port < 1 || port > 65535) {
            console.error('❌ Error: Port must be a number between 1 and 65535');
            process.exit(1);
        }

        // Validate origin URL
        try {
            const parsedUrl = new URL(options.origin);
            if (!parsedUrl.protocol || !parsedUrl.hostname) {
                throw new Error('Invalid URL format');
            }
        } catch (error) {
            console.error('❌ Error: Invalid origin URL format');
            console.log('Example: https://dummyjson.com or https://api.github.com');
            process.exit(1);
        }

        // Start the proxy server
        const proxy = new CachingProxy();
        try {
            await proxy.start(port, options.origin);
        } catch (error) {
            console.error(`❌ Failed to start server: ${error.message}`);
            process.exit(1);
        }
    });

// Clear cache command
program
    .command('clear-cache')
    .description('clear all cached responses')
    .action(() => {
        const proxy = new CachingProxy();
        proxy.clearCache();
    });

// Show cache info command
program
    .command('cache-info')
    .description('show cache information and statistics')
    .action(() => {
        const proxy = new CachingProxy();
        const info = proxy.getCacheInfo();
        
        console.log(`📊 Cache Information:`);
        console.log(`   Location: ${info.location}`);
        console.log(`   Entries: ${info.entries}`);
        
        if (info.entries > 0) {
            console.log(`\n📋 Recent Cache Entries:`);
            info.cacheData.forEach((entry, index) => {
                console.log(`   ${index + 1}. Status ${entry.statusCode} - ${entry.age}s ago - ${entry.dataLength} bytes`);
            });
            
            if (info.entries > 10) {
                console.log(`   ... and ${info.entries - 10} more entries`);
            }
        }
    });

// Parse command line arguments
program.parse(process.argv);

// If no arguments provided and it's the main command, show help
if (process.argv.length <= 2) {
    program.outputHelp();
}
