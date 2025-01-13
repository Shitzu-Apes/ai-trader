module.exports = {
	apps: [
		{
			name: 'binance-api',
			cwd: './binance-api',
			script: 'node_modules/.bin/tsx',
			args: 'src/index.ts',
			watch: ['src'],
			ignore_watch: ['node_modules'],
			instances: 1,
			autorestart: true,
			max_restarts: 10,
			restart_delay: 4000,
			exp_backoff_restart_delay: 100,
			max_memory_restart: '1G',
			env: {
				NODE_ENV: 'development',
				PORT: 3001
			},
			env_production: {
				NODE_ENV: 'production',
				PORT: 3001
			},
			log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
			merge_logs: true,
			error_file: 'logs/error.log',
			out_file: 'logs/out.log',
			time: true
		}
	]
};
