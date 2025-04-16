import { ServiceSchema, Context } from "moleculer";
import { Pool } from "pg";

const pool = new Pool({
	user: process.env.PG_USER,
	password: process.env.PG_PASSWORD,
	host: process.env.PG_HOST,
	port: process.env.PG_PORT ? Number(process.env.PG_PORT) : 5432,
	database: process.env.PG_DATABASE,
	max: 20,
	idleTimeoutMillis: 30000,
	connectionTimeoutMillis: 2000,
});

// Define the shape of your meta
interface CustomMeta {
	source?: string;
}

const RawFhirService: ServiceSchema = {
	name: "raw.fhir",

	actions: {
		save: {
			rest: {
				method: "POST",
				path: "/",
			},
			async handler(ctx: Context<Record<string, any>, CustomMeta>) {
				const rawFhirBundle = ctx.params;

				try {
					await pool.query(
						`INSERT INTO emr_fhir_bundles (source, data) VALUES ($1, $2)`,
						[ctx.meta?.source || "UgandaEMR", rawFhirBundle]
					);
					return { success: true, message: "FHIR bundle saved successfully." };
				} catch (error) {
					this.logger.error("Error saving FHIR bundle", error);
					return { success: false, error: error.message };
				}
			},
		},
	},
};

export default RawFhirService;
