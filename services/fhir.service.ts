/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Bull from "bull";
import { fromPairs } from "lodash";
import type { Context, Service, ServiceSchema, ServiceSettingSchema } from "moleculer";
import { Pool } from "pg";
import format from "pg-format";

export interface ActionHelloParams {
	name: string;
}

interface GreeterSettings extends ServiceSettingSchema {
	defaultName: string;
}

interface GreeterMethods {
	uppercase(str: string): string;
}

interface GreeterLocalVars {
	myVar: string;
}

type GreeterThis = Service<GreeterSettings> & GreeterMethods & GreeterLocalVars;

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

const fhirQueue = new Bull<{
	data: { encounters: string[][]; patients: string[][] };
}>("fhir");

const insert = async ({ data }: { data: { encounters: string[][]; patients: string[][] } }) => {
	const connection = await pool.connect();
	try {
		if (data.patients.length > 0) {
			await connection.query(
				format(
					`INSERT INTO staging_patient ( case_id,sex,date_of_birth,deceased,date_of_death,facility_id,patient_clinic_no,patient_name,phone_number)
                            VALUES %L ON CONFLICT (case_id) DO UPDATE SET sex = EXCLUDED.sex,date_of_birth = EXCLUDED.date_of_birth,deceased = EXCLUDED.deceased,date_of_death = EXCLUDED.date_of_death,
                            facility_id = EXCLUDED.facility_id,patient_clinic_no = EXCLUDED.patient_clinic_no,patient_name=EXCLUDED.patient_name,phone_number=EXCLUDED.phone_number,updated_date=current_timestamp;`,
					data.patients,
				),
			);
			console.log(format(
				"INSERT INTO staging_patient_encounters(case_id,encounter_id,encounter_date,facility_id,encounter_type,obs) VALUES %L ON CONFLICT (encounter_id) DO UPDATE SET case_id = EXCLUDED.case_id,encounter_date = EXCLUDED.encounter_date,facility_id = EXCLUDED.facility_id,encounter_type = EXCLUDED.encounter_type,obs=EXCLUDED.obs",
				data.encounters,
			))
			if (data.encounters.length > 0) {
				await connection.query(
					format(
						"INSERT INTO staging_patient_encounters(case_id,encounter_id,encounter_date,facility_id,encounter_type,obs) VALUES %L ON CONFLICT (encounter_id) DO UPDATE SET case_id = EXCLUDED.case_id,encounter_date = EXCLUDED.encounter_date,facility_id = EXCLUDED.facility_id,encounter_type = EXCLUDED.encounter_type,obs=EXCLUDED.obs,updated_date=current_timestamp",
						data.encounters,
					),
				);
			}
		}
	} catch (error) {
		console.log(error);
	} finally {
		connection.release();
	}
};

fhirQueue.process((job) => insert(job.data));
const GreeterService: ServiceSchema<GreeterSettings> = {
	name: "fhir",

	/**
	 * Settings
	 */
	settings: {
		defaultName: "Fhir",
	},

	/**
	 * Dependencies
	 */
	dependencies: [],

	/**
	 * Actions
	 */
	actions: {
		add: {
			rest: {
				method: "POST",
				path: "/",
			},
			handler(this: GreeterThis, ctx: Context<Record<string, any>>) {
				let allPatients: any[] = [];
				let allObservations: any[] = [];
				let allEncounters: any[] = [];
				ctx.params.entry.forEach((entry: any) => {
					if (entry.resource && entry.resource.resourceType === "Patient") {
						allPatients = [...allPatients, entry];
					}

					if (entry.resourceType && entry.resourceType === "Patient") {
						allPatients = [...allPatients, { resource: entry }];
					}
					if (entry.resource && entry.resource.resourceType === "Encounter") {
						allEncounters = [...allEncounters, entry];
					}

					if (entry.resourceType && entry.resourceType === "Encounter") {
						allEncounters = [...allEncounters, { resource: entry }];
					}

					if (entry.resource && entry.resource.resourceType === "Observation") {
						allObservations = [...allObservations, entry];
					}

					if (entry.resourceType && entry.resourceType === "Observation") {
						allObservations = [...allObservations, { resource: entry }];
					}
				});

				const patients: string[][] = this.processPatients(allPatients);
				const encounters: string[][] = this.processEncounters(allEncounters);
				const observations: any[] = this.processObs(allObservations);

				const data = {
					patients,
					encounters: encounters.map((e) => {
						const encounterId = e[1];
						this.logger.info(encounterId);
						const encounterObs = fromPairs(
							observations
								.filter((o) => o.encounterId === encounterId)
								.map((currentObs: any) => [currentObs.obs_name, currentObs]),
						);
						return [...e, JSON.stringify(encounterObs)];
					}),
				};
				return fhirQueue.add({
					data,
				});
			},
		},
	},

	/**
	 * Events
	 */
	events: {},

	/**
	 * Methods
	 */
	methods: {
		processPatients(patients) {
			this.logger.info("Are we here");
			const processedPatient = [];
			for (const patient of patients) {
				let patientInfo = {
					case_id: patient.resource.id,
					sex: patient.resource.gender,
					date_of_birth: patient.resource.birthDate,
					patient_name: "",
					deceased: patient.resource.deceasedBoolean,
					date_of_death: patient.resource.deceasedDateTime || null,
					facility_id: "",
					patient_clinic_number: null,
					phone_number: null,
				};

				if (patient.resource.identifier) {
					const patientClinicNo = patient.resource.identifier.find(
						({ type: { text } }: { type: { text: string } }) =>
							text === "HIV Clinic No.",
					);
					if (patientClinicNo) {
						patientInfo = {
							...patientInfo,
							patient_clinic_number: patientClinicNo.value,
						};
					}
				}
				if (patient.resource.name) {
					const givenName = patient.resource.name[0]?.given?.[0] || "";
					const familyName = patient.resource.name[0]?.family || "";
					const patientName = `${givenName} ${familyName}`;
					patientInfo = {
						...patientInfo,
						patient_name: patientName.trim(),
					};
				}
				if (patient.resource.telecom) {
					const telecomValue = patient.resource.telecom[0].value;
					patientInfo = {
						...patientInfo,
						phone_number: telecomValue,
					};
				}

				if (patient.resource.managingOrganization) {
					patientInfo = {
						...patientInfo,
						facility_id: String(patient.resource.managingOrganization.reference).split(
							"/",
						)[1],
					};
				}
				if (patientInfo.date_of_birth && patientInfo.date_of_birth.length === 4) {
					patientInfo = {
						...patientInfo,
						date_of_birth: `${patientInfo.date_of_birth}-01-01`,
					};
				}
				if (
					patientInfo.case_id &&
					patientInfo.date_of_birth &&
					patientInfo.date_of_birth.length === 10 &&
					patientInfo.sex &&
					patientInfo.facility_id
				) {
					processedPatient.push([
						patientInfo.case_id,
						patientInfo.sex,
						patientInfo.date_of_birth,
						patientInfo.deceased,
						patientInfo.date_of_death,
						patientInfo.facility_id,
						patientInfo.patient_clinic_number,
						patientInfo.patient_name,
						patientInfo.phone_number,
					]);
				}
			}
			return processedPatient;
		},

		processObs(observations) {
			const obs = [];
			if (observations && observations.length > 0) {
				for (const bundle of observations) {
					const {
						id,
						valueQuantity,
						valueCodeableConcept,
						valueString,
						valueBoolean,
						valueInteger,
						valueTime,
						valueDateTime,
						encounter: { reference: ref },
						effectiveDateTime,
						code,
						subject: { reference },
					} = bundle.resource;
					let realValue =
						valueString || valueBoolean || valueInteger || valueTime || valueDateTime;

					if (valueQuantity) {
						realValue = valueQuantity.value;
					}
					if (valueCodeableConcept) {
						const {
							coding: [{ display }],
						} = valueCodeableConcept;
						realValue = display;
					}
					const patient = String(reference).split("/")[1];
					const encounterId = String(ref).split("/")[1];
					if (realValue && code && code.coding && code.coding.length > 1) {
						const {
							coding: [{ display: obsName, code: code1 }, { code: code2 }],
						} = code;
						obs.push({
							id,
							patient,
							encounterId,
							code: code2,
							uuid: code1,
							obs_name: obsName,
							realValue,
							effectiveDateTime,
						});
					}
				}
			}
			return obs;
		},

		processEncounters(encounters) {
			const processed = [];
			if (encounters && encounters.length > 0) {
				for (const bundle of encounters) {
					const { id, type, period, subject, serviceProvider } = bundle.resource;
					if (type && type.length > 0 && id && period && subject && serviceProvider) {
						const [
							{
								coding: [{ code }],
							},
						] = type;
						const { start: encounterDate } = period;
						const { reference } = subject;
						const { reference: facility } = serviceProvider;
						const patientId = String(reference).split("/")[1];
						const facilityId = String(facility).split("/")[1];
						processed.push([patientId, id, encounterDate, facilityId, code]);
					}
				}
			}
			return processed;
		},
	},

	/**
	 * Service created lifecycle event handler
	 */
	created() {},

	/**
	 * Service started lifecycle event handler
	 */
	async started() {},

	/**
	 * Service stopped lifecycle event handler
	 */
	async stopped() {},
};

export default GreeterService;
